//! 表达式解析与归一化:词法 + Pratt 语法分析产出 `Expr` 树,随后做
//! 别名重写(pow/log/sec/deg...)与"函数是否支持数值求值"的校验.
//!
//! 行为契约:
//! - 归一化产物是**可执行字符串**:数字必须 round-trip(打印契约见
//!   `printing.rs` 文件头),函数名与元数统一在这里校验;
//! - 解析阶段就保证表达式树深度不超过 [`MAX_TREE_DEPTH`],因此后续**所有**
//!   按树递归的遍历(别名重写/打印/化简/求导/变量提取/`Drop`)都有界;
//! - 多字母标识符是**单个符号**:`lex_ident` 贪婪吃字母数字下划线,且 `_`
//!   是名字的一部分(不是下标运算符).因此 `2xy` == `2 * xy`(变量 `xy`),
//!   `x2`,`sinx`,`x_1` 都是合法变量名;`1e` 是 `1 * e`(e 在归一化阶段被
//!   折叠成 2.718281828459045),而 `1e-20` 因指数分支被读成单个数字.
//!   这条语义由 `multi_letter_identifiers_are_single_symbols` 固定.
//!
//! 编码注意:
//! - 解析是递归下降(括号/函数参数/右结合幂链/一元链都按嵌套深度递归),
//!   嵌套深度受 [`MAX_PARSE_DEPTH`] 护栏保护;它**只**防语法递归,不防
//!   "左结合长链"(parse 深度恒为 2,产出的却是 N 深左倾树),后者由
//!   [`MAX_TREE_DEPTH`] 的节点预算兜底(SYM-P1.3);
//! - 隐式乘法(2x,2 sin(x),(x+1)(x-1))在 parse_expr 循环里按原子判定,
//!   不要改成独立运算符,否则会破坏 2/(3x) 这类既有结合性;
//! - 词法对畸形数字宽容(如 "1.2.3" 会被读成两个数再隐式相乘)--这是
//!   历史行为,新代码不要让它变得更安静,出错信息仍尽量带定位.
//!
//! 202609 审查修复锚点(本仓库内引用统一用 `SYM-` 前缀,避免与旧报告编号冲突):
//! - `SYM-P1.2`:空参调用不得 panic;
//! - `SYM-P1.3`:树深预算封住所有递归遍历;
//! - `SYM-P2.1`:元数校验单点收口.

use super::{BinOp, Expr, UnaryOp};
use crate::builtins;

/// 表达式**语法嵌套**深度上限(括号/函数参数/一元与幂链),防止递归下降
/// 解析自身栈溢出.正常表达式远小于该值;越界报错并提示简化表达式.
///
/// 它不限制表达式**树深**:`x + x + ... + x` 这种左结合链在解析期深度恒为
/// 2,但会产出 N 深左倾树,那部分由 [`MAX_TREE_DEPTH`] 负责.
const MAX_PARSE_DEPTH: usize = 512;

/// 表达式**树深**上限(SYM-P1.3).
///
/// 左结合长链(`x + x + ...`)与长函数参数链在解析期不触发语法深度护栏,
/// 却会产出深树;之后的别名重写/打印/化简/求导/`Drop` 全按树递归,在 wasm
/// 1 MiB 栈上约 2.7 千项即 abort(不可 catch 的进程级错误).
///
/// 预算在**构造节点时**检查(而不是解析结束后再测深度--测深度那次遍历
/// 自己就会溢出),这样任何成功解析的树都保证深度有界.
///
/// 阈值取值(实测,探针见 202609 审查 SYM-P1.3 与本次修复记录):
/// - N 项左结合链的树深 = N;求导是最紧的遍历(递归里反复调
///   `is_const_except` 与 `simplify`),打印/归一化次之;
/// - debug 2 MiB 线程实测:求导 192 层 OK / 200 层溢出,打印 256 层仍 OK;
/// - release 1 MiB(近似 wasm)实测:512 层各遍历都 OK;
/// - 真实 wasm(wasm-pack release,1 MiB 栈)实测:512 项 OK,
///   513 项起由本预算返回可读 `Err`,4000 项也不 trap.
///
/// 取 128:对 debug 求导(200 崩)留 1.5 倍余量,对 wasm release 留 4 倍余量;
/// 手写表达式远达不到这个深度.现有 600 层括号用例依旧先被
/// [`MAX_PARSE_DEPTH`] 拦下,报错形态不变.
///
/// 调大这个值之前,必须重跑 `deepest_allowed_tree_is_safe_for_every_traversal`
/// 在 debug(`cargo test`)下的用例--它会把"预算"与"遍历栈开销"绑在一起.
pub(crate) const MAX_TREE_DEPTH: usize = 128;

/// 子树深度(叶子为 1).
///
/// 只在**已通过预算**的子树上调用:每次构造新节点都会先检查深度,所以
/// 能进到这里的最深树就是 [`MAX_TREE_DEPTH`],递归本身有界.
fn tree_depth(expr: &Expr) -> usize {
    match expr {
        Expr::Num(_) | Expr::Sym(_) => 1,
        Expr::Unary(_, operand) => 1 + tree_depth(operand),
        Expr::Binary(_, left, right) => 1 + tree_depth(left).max(tree_depth(right)),
        Expr::Call(_, args) => 1 + args.iter().map(tree_depth).max().unwrap_or(0),
        Expr::List(items) => 1 + items.iter().map(tree_depth).max().unwrap_or(0),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
    LBracket,
    RBracket,
    Comma,
    End,
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn new(source: &str) -> Self {
        Self {
            chars: source.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_next(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(ch) if ch.is_whitespace()) {
            self.bump();
        }
    }

    fn lex(mut self) -> Result<Vec<Token>, String> {
        let mut tokens = Vec::new();
        loop {
            self.skip_whitespace();
            let Some(ch) = self.peek() else {
                tokens.push(Token::End);
                return Ok(tokens);
            };

            match ch {
                '+' => {
                    self.bump();
                    tokens.push(Token::Plus);
                }
                '-' => {
                    self.bump();
                    tokens.push(Token::Minus);
                }
                '*' => {
                    self.bump();
                    tokens.push(Token::Star);
                }
                '/' => {
                    self.bump();
                    tokens.push(Token::Slash);
                }
                '^' => {
                    self.bump();
                    tokens.push(Token::Caret);
                }
                '(' => {
                    self.bump();
                    tokens.push(Token::LParen);
                }
                ')' => {
                    self.bump();
                    tokens.push(Token::RParen);
                }
                '[' => {
                    self.bump();
                    tokens.push(Token::LBracket);
                }
                ']' => {
                    self.bump();
                    tokens.push(Token::RBracket);
                }
                ',' => {
                    self.bump();
                    tokens.push(Token::Comma);
                }
                _ if ch.is_ascii_digit() || ch == '.' => {
                    tokens.push(self.lex_number()?);
                }
                _ if ch.is_alphabetic() || ch == '_' => {
                    tokens.push(Token::Ident(self.lex_ident()));
                }
                _ => {
                    return Err(format!("表达式包含无法识别的字符: {ch:?}"));
                }
            }
        }
    }

    fn lex_number(&mut self) -> Result<Token, String> {
        let start = self.pos;
        let mut saw_dot = false;
        while let Some(ch) = self.peek() {
            if ch.is_ascii_digit() {
                self.bump();
            } else if ch == '.' && !saw_dot {
                saw_dot = true;
                self.bump();
            } else {
                break;
            }
        }

        if matches!(self.peek(), Some('e' | 'E')) {
            let exponent_sign = matches!(self.peek_next(), Some('+' | '-'));
            if exponent_sign || matches!(self.peek_next(), Some(ch) if ch.is_ascii_digit()) {
                self.bump();
                if matches!(self.peek(), Some('+' | '-')) {
                    self.bump();
                }
                while matches!(self.peek(), Some(ch) if ch.is_ascii_digit()) {
                    self.bump();
                }
            }
        }

        let text: String = self.chars[start..self.pos].iter().collect();
        let value: f64 = text.parse().map_err(|_| format!("无法解析数字: {text}"))?;
        Ok(Token::Num(value))
    }

    fn lex_ident(&mut self) -> String {
        let start = self.pos;
        while matches!(
            self.peek(),
            Some(ch) if ch.is_ascii_alphanumeric() || ch == '_'
        ) {
            self.bump();
        }
        self.chars[start..self.pos].iter().collect()
    }
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
    /// 当前递归嵌套深度(parse_expr 护栏用,见 [`MAX_PARSE_DEPTH`]).
    depth: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self {
            tokens,
            pos: 0,
            depth: 0,
        }
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.pos]
    }

    fn bump(&mut self) -> Token {
        let token = self.tokens[self.pos].clone();
        if !matches!(token, Token::End) {
            self.pos += 1;
        }
        token
    }

    fn is_atom(&self) -> bool {
        matches!(
            self.peek(),
            Token::Num(_) | Token::Ident(_) | Token::LParen | Token::LBracket
        )
    }

    fn parse(mut self) -> Result<Expr, String> {
        let expr = self.parse_expr(0)?;
        if !matches!(self.peek(), Token::End) {
            return Err(format!(
                "表达式末尾存在无法解析的内容: {}",
                self.token_desc(self.peek())
            ));
        }
        Ok(expr)
    }

    fn token_desc(&self, token: &Token) -> String {
        match token {
            Token::Num(value) => format!("数字 {value}"),
            Token::Ident(name) => name.clone(),
            Token::Plus => "+".to_string(),
            Token::Minus => "-".to_string(),
            Token::Star => "*".to_string(),
            Token::Slash => "/".to_string(),
            Token::Caret => "^".to_string(),
            Token::LParen => "(".to_string(),
            Token::RParen => ")".to_string(),
            Token::LBracket => "[".to_string(),
            Token::RBracket => "]".to_string(),
            Token::Comma => ",".to_string(),
            Token::End => "表达式末尾".to_string(),
        }
    }

    /// 表达式入口(带深度护栏):所有递归(右结合幂链,括号,函数参数,
    /// 一元链,数组嵌套)都从这里再次进入,深度越界即报错.
    pub(crate) fn parse_expr(&mut self, min_prec: u8) -> Result<Expr, String> {
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            self.depth -= 1;
            return Err("表达式嵌套过深(超过 512 层),请简化表达式".to_string());
        }
        let result = self.parse_expr_inner(min_prec);
        self.depth -= 1;
        result
    }

    /// 构造节点前的树深预算检查(SYM-P1.3):越界报可读错误,绝不产出深树.
    fn check_tree_depth(&self, expr: &Expr) -> Result<(), String> {
        if tree_depth(expr) > MAX_TREE_DEPTH {
            return Err(format!(
                "表达式结构过深(超过 {MAX_TREE_DEPTH} 层),请拆分成多个表达式"
            ));
        }
        Ok(())
    }

    fn parse_expr_inner(&mut self, min_prec: u8) -> Result<Expr, String> {
        let mut lhs = self.parse_prefix()?;

        loop {
            let (op, left_prec, right_prec) = if matches!(self.peek(), Token::Plus) {
                (Some(BinOp::Add), 20, 21)
            } else if matches!(self.peek(), Token::Minus) {
                (Some(BinOp::Sub), 20, 21)
            } else if matches!(self.peek(), Token::Star) {
                (Some(BinOp::Mul), 40, 41)
            } else if matches!(self.peek(), Token::Slash) {
                (Some(BinOp::Div), 40, 41)
            } else if matches!(self.peek(), Token::Caret) {
                // 幂运算右结合.
                (Some(BinOp::Pow), 70, 70)
            } else if self.is_atom() {
                // 2x/2 sin(x)/(x+1)(x-1) 等隐式乘法.
                (Some(BinOp::Mul), 50, 51)
            } else {
                (None, 0, 0)
            };

            let Some(op) = op else {
                break;
            };
            if left_prec < min_prec {
                break;
            }

            if !matches!(
                self.peek(),
                Token::Plus | Token::Minus | Token::Star | Token::Slash | Token::Caret
            ) {
                // 隐式乘法:当前 token 是右操作数的开始,不能先消费.
            } else {
                self.bump();
            }
            let rhs = self.parse_expr(right_prec)?;
            // 左结合链在这里逐层加深,预算检查必须放在构造之前.
            let node = Expr::Binary(op, Box::new(lhs), Box::new(rhs));
            self.check_tree_depth(&node)?;
            lhs = node;
        }

        Ok(lhs)
    }

    fn parse_prefix(&mut self) -> Result<Expr, String> {
        if matches!(self.peek(), Token::Plus) {
            self.bump();
            return self.parse_expr(60);
        }
        if matches!(self.peek(), Token::Minus) {
            self.bump();
            let operand = self.parse_expr(60)?;
            let node = Expr::Unary(UnaryOp::Neg, Box::new(operand));
            self.check_tree_depth(&node)?;
            return Ok(node);
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        match self.peek().clone() {
            Token::Num(value) => {
                self.bump();
                Ok(Expr::Num(value))
            }
            Token::Ident(name) => {
                self.bump();
                if matches!(self.peek(), Token::LParen) {
                    self.bump();
                    let mut args = Vec::new();
                    if matches!(self.peek(), Token::RParen) {
                        self.bump();
                        return Ok(Expr::Call(name, args));
                    }
                    loop {
                        args.push(self.parse_expr(0)?);
                        match self.peek() {
                            Token::Comma => {
                                self.bump();
                                if matches!(self.peek(), Token::RParen) {
                                    self.bump();
                                    break;
                                }
                            }
                            Token::RParen => {
                                self.bump();
                                break;
                            }
                            _ => return Err("函数参数列表缺少右括号或逗号".to_string()),
                        }
                    }
                    let node = Expr::Call(name, args);
                    self.check_tree_depth(&node)?;
                    Ok(node)
                } else {
                    Ok(Expr::Sym(name))
                }
            }
            Token::LParen => {
                self.bump();
                let expr = self.parse_expr(0)?;
                if !matches!(self.peek(), Token::RParen) {
                    return Err("表达式缺少右括号".to_string());
                }
                self.bump();
                Ok(expr)
            }
            Token::LBracket => self.parse_list(),
            other => Err(format!(
                "期望数字/变量/函数或括号,但得到: {}",
                self.token_desc(&other)
            )),
        }
    }

    fn parse_list(&mut self) -> Result<Expr, String> {
        debug_assert!(matches!(self.peek(), Token::LBracket));
        self.bump();
        let mut items = Vec::new();
        if matches!(self.peek(), Token::RBracket) {
            self.bump();
            return Ok(Expr::List(items));
        }

        loop {
            items.push(self.parse_expr(0)?);
            match self.peek() {
                Token::Comma => {
                    self.bump();
                    if matches!(self.peek(), Token::RBracket) {
                        self.bump();
                        break;
                    }
                }
                Token::RBracket => {
                    self.bump();
                    break;
                }
                _ => return Err("数组缺少右方括号或逗号".to_string()),
            }
        }
        let node = Expr::List(items);
        self.check_tree_depth(&node)?;
        Ok(node)
    }
}

pub(crate) fn parse_expr(source: &str) -> Result<Expr, String> {
    if source.trim().is_empty() {
        return Err("表达式不能为空".to_string());
    }
    let tokens = Lexer::new(source).lex()?;
    Parser::new(tokens).parse()
}

// ============================================================
// 别名归一化
// ============================================================

pub(crate) fn rewrite_aliases(expr: &Expr) -> Result<Expr, String> {
    let mut expr = expr.clone();
    rewrite_aliases_inner(&mut expr)?;
    Ok(expr)
}

fn rewrite_aliases_inner(expr: &mut Expr) -> Result<(), String> {
    match expr {
        Expr::Unary(_, operand) => rewrite_aliases_inner(operand),
        Expr::Binary(_, left, right) => {
            rewrite_aliases_inner(left)?;
            rewrite_aliases_inner(right)
        }
        Expr::List(items) => {
            for item in items {
                rewrite_aliases_inner(item)?;
            }
            Ok(())
        }
        Expr::Call(name, args) => {
            for arg in args.iter_mut() {
                rewrite_aliases_inner(arg)?;
            }
            if let Some(expanded) = builtins::alias_expansion(name, args) {
                *expr = expanded?;
            }
            Ok(())
        }
        Expr::Sym(name) => {
            // 常量折叠名单收口在 builtins;只折叠 pi/PI/e/E(与旧行为一致).
            if let Some(value) = builtins::foldable_constant_value(name) {
                *expr = Expr::Num(value);
            }
            Ok(())
        }
        Expr::Num(_) => Ok(()),
    }
}

/// 校验"函数名 + 元数"是否可交给数值求值.
///
/// 元数检查在别名重写**之后**执行:`pow(x)`, `deg(x, y)` 这类别名错误由
/// 展开函数报错(它们展开后的参数个数与基础函数元数无关),而展开后的
/// 基础函数(`sqrt()`, `sin(x, y)`)由 `builtins::check_function_arity`
/// 统一报错(202609 审查 SYM-P2.1).
pub(crate) fn validate_supported(expr: &Expr) -> Result<(), String> {
    match expr {
        Expr::Call(name, args) => {
            builtins::check_function_arity(name, args.len())?;
            for arg in args {
                validate_supported(arg)?;
            }
            Ok(())
        }
        Expr::Unary(_, operand) => validate_supported(operand),
        Expr::Binary(_, left, right) => {
            validate_supported(left)?;
            validate_supported(right)
        }
        Expr::List(items) => {
            for item in items {
                validate_supported(item)?;
            }
            Ok(())
        }
        Expr::Num(_) | Expr::Sym(_) => Ok(()),
    }
}
