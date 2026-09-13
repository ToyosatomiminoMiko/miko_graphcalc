//! 符号求导:链式法则展开后交给 `simplify` 化简.

use super::parser::{rewrite_aliases, validate_supported};
use super::simplify::simplify;
use super::{BinOp, Expr, UnaryOp};
use crate::builtins;

fn is_const_except(expr: &Expr, variable: &str) -> bool {
    match expr {
        Expr::Num(_) => true,
        Expr::Sym(name) => name != variable,
        Expr::Unary(_, operand) => is_const_except(operand, variable),
        Expr::Binary(_, left, right) => {
            is_const_except(left, variable) && is_const_except(right, variable)
        }
        Expr::Call(_, args) => args.iter().all(|arg| is_const_except(arg, variable)),
        Expr::List(_) => false,
    }
}

pub(crate) fn derivative(expr: &Expr, variable: &str) -> Result<Expr, String> {
    let expr = rewrite_aliases(expr)?;
    validate_supported(&expr)?;
    Ok(simplify(derivative_inner(&expr, variable)?))
}

fn derivative_inner(expr: &Expr, variable: &str) -> Result<Expr, String> {
    match expr {
        Expr::Num(_) => Ok(Expr::Num(0.0)),
        Expr::Sym(name) => Ok(if name == variable {
            Expr::Num(1.0)
        } else {
            Expr::Num(0.0)
        }),
        Expr::Unary(UnaryOp::Neg, operand) => Ok(Expr::Unary(
            UnaryOp::Neg,
            Box::new(derivative_inner(operand, variable)?),
        )),
        Expr::Binary(op, left, right) => {
            if is_const_except(expr, variable) {
                return Ok(Expr::Num(0.0));
            }
            derivative_binary(*op, left, right, variable)
        }
        Expr::Call(name, args) => {
            if is_const_except(expr, variable) {
                return Ok(Expr::Num(0.0));
            }
            derivative_call(name, args, variable)
        }
        Expr::List(_) => Err("不能对数组表达式直接求导".to_string()),
    }
}

fn derivative_binary(op: BinOp, left: &Expr, right: &Expr, variable: &str) -> Result<Expr, String> {
    match op {
        BinOp::Add => Ok(Expr::Binary(
            BinOp::Add,
            Box::new(derivative_inner(left, variable)?),
            Box::new(derivative_inner(right, variable)?),
        )),
        BinOp::Sub => Ok(Expr::Binary(
            BinOp::Sub,
            Box::new(derivative_inner(left, variable)?),
            Box::new(derivative_inner(right, variable)?),
        )),
        BinOp::Mul => {
            if is_const_except(left, variable) {
                return Ok(Expr::Binary(
                    BinOp::Mul,
                    Box::new(left.clone()),
                    Box::new(derivative_inner(right, variable)?),
                ));
            }
            if is_const_except(right, variable) {
                return Ok(Expr::Binary(
                    BinOp::Mul,
                    Box::new(right.clone()),
                    Box::new(derivative_inner(left, variable)?),
                ));
            }
            Ok(Expr::Binary(
                BinOp::Add,
                Box::new(Expr::Binary(
                    BinOp::Mul,
                    Box::new(derivative_inner(left, variable)?),
                    Box::new(right.clone()),
                )),
                Box::new(Expr::Binary(
                    BinOp::Mul,
                    Box::new(left.clone()),
                    Box::new(derivative_inner(right, variable)?),
                )),
            ))
        }
        BinOp::Div => {
            if is_const_except(right, variable) {
                return Ok(Expr::Binary(
                    BinOp::Div,
                    Box::new(derivative_inner(left, variable)?),
                    Box::new(right.clone()),
                ));
            }
            if is_const_except(left, variable) {
                return Ok(Expr::Binary(
                    BinOp::Mul,
                    Box::new(Expr::Unary(UnaryOp::Neg, Box::new(left.clone()))),
                    Box::new(Expr::Binary(
                        BinOp::Div,
                        Box::new(derivative_inner(right, variable)?),
                        Box::new(Expr::Binary(
                            BinOp::Pow,
                            Box::new(right.clone()),
                            Box::new(Expr::Num(2.0)),
                        )),
                    )),
                ));
            }
            Ok(Expr::Binary(
                BinOp::Div,
                Box::new(Expr::Binary(
                    BinOp::Sub,
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(derivative_inner(left, variable)?),
                        Box::new(right.clone()),
                    )),
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(left.clone()),
                        Box::new(derivative_inner(right, variable)?),
                    )),
                )),
                Box::new(Expr::Binary(
                    BinOp::Pow,
                    Box::new(right.clone()),
                    Box::new(Expr::Num(2.0)),
                )),
            ))
        }
        BinOp::Pow => {
            if is_const_except(left, variable) {
                return Ok(Expr::Binary(
                    BinOp::Mul,
                    Box::new(Expr::Binary(
                        BinOp::Pow,
                        Box::new(left.clone()),
                        Box::new(right.clone()),
                    )),
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(Expr::Call("ln".to_string(), vec![left.clone()])),
                        Box::new(derivative_inner(right, variable)?),
                    )),
                ));
            }
            if is_const_except(right, variable) {
                return Ok(Expr::Binary(
                    BinOp::Mul,
                    Box::new(right.clone()),
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(derivative_inner(left, variable)?),
                        Box::new(Expr::Binary(
                            BinOp::Pow,
                            Box::new(left.clone()),
                            Box::new(Expr::Binary(
                                BinOp::Sub,
                                Box::new(right.clone()),
                                Box::new(Expr::Num(1.0)),
                            )),
                        )),
                    )),
                ));
            }
            Ok(Expr::Binary(
                BinOp::Mul,
                Box::new(Expr::Binary(
                    BinOp::Pow,
                    Box::new(left.clone()),
                    Box::new(right.clone()),
                )),
                Box::new(Expr::Binary(
                    BinOp::Add,
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(derivative_inner(left, variable)?),
                        Box::new(Expr::Binary(
                            BinOp::Div,
                            Box::new(right.clone()),
                            Box::new(left.clone()),
                        )),
                    )),
                    Box::new(Expr::Binary(
                        BinOp::Mul,
                        Box::new(derivative_inner(right, variable)?),
                        Box::new(Expr::Call("ln".to_string(), vec![left.clone()])),
                    )),
                )),
            ))
        }
    }
}

fn derivative_call(name: &str, args: &[Expr], variable: &str) -> Result<Expr, String> {
    let arg = args
        .first()
        .ok_or_else(|| format!("函数 {name} 至少需要一个参数"))?;
    let darg = derivative_inner(arg, variable)?;

    let derivative = builtins::derivative_unary(name)
        .ok_or_else(|| format!("表达式暂不支持函数 {name} 的符号求导"))?;
    let func = derivative(arg);

    Ok(Expr::Binary(BinOp::Mul, Box::new(darg), Box::new(func)))
}
