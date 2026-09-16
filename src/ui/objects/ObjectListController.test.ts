/**
 * 求值列表条目结构单测(最小 DOM 桩,见 test/domStub.ts,不引入 jsdom).
 *
 * 锁的是几条来自实际反馈的约束:
 * 1. 行里**没有自建的开合按钮**:开合交给 <details>/<summary> 原生行为
 *    (摘要行就是 <summary>,点它由浏览器开合);
 * 2. 行末有**显隐按钮**(`.row-visibility-btn`):它是业务动作(隐藏 =
 *    不渲染 + 不参与计算),回调给应用层;按钮与主内容包装 `.row-main` 平级,
 *    在行末靠右,不在 <summary> 内,点它不会开合细节;
 * 3. 折叠态只有一行 KaTeX 公式;
 * 4. 展开细节逐行分块(.eval-details 下每行一个 .eval-detail-line),不是
 *    一堆 inline 公式挤成一行;结果行在 <details> 内,跟着一起开合.
 *
 * DOM 桩与其它 ui 控制器测试共用一份(`test/domStub.ts`);KaTeX 用
 * render(tex, el) 写回 textContent 的假实现,断言只看结构与 LaTeX 文本,
 * 不看排版.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult, SceneIR, SceneObject, SolveTask } from '../../ir';
import { installDomStub, StubElement } from '../../test/domStub';

vi.mock('katex', () => ({
    default: {
        // 真 KaTeX 会把排版结果写进传入的元素;桩里直接回写 TeX 文本,
        // FormulaView 的模板 clone 才能带上内容.
        render: (tex: string, element: { textContent: string }) => {
            element.textContent = tex;
        },
    },
}));
vi.mock('katex/dist/katex.min.css', () => ({}));

import { ObjectListController } from './ObjectListController';

beforeEach(() => {
    installDomStub();
});

const analysis: AnalysisResult = {
    name: 'g',
    op: 'gradient',
    point: [1, 2, 3],
    symbolic: '\\nabla f=(a, b, c)',
    vector: [0.1, 0.2, 0.3],
    tangent: null,
    scalar: 4,
    show: ['point', 'normal'],
    enabled: true,
};

const curve: SceneObject = {
    kind: 'curve',
    id: 1,
    name: 'c1',
    expr: 'sin(x*a)*cos(x*b)',
    coefficients: [],
    color: '#ffffff',
    enabled: true,
};

const scene = {
    params: [],
    objects: [curve],
    objectFormulas: { 1: 'y=1' },
    integralFormulas: {},
    objectTransforms: {},
    animations: [],
    objectAnimations: {},
    analyses: [analysis],
    integrals: [
        {
            name: 'I',
            objectId: 1,
            sourceKind: 'curve',
            dim: 1,
            domainKind: 'interval',
            method: 'riemann:mid',
            integrand: 'sin(x*a)*cos(x*b)',
            integrandCoefficients: [],
            countCoefficients: [],
            range: [-4, 4],
            segments: 32,
            layers: 32,
            show: true,
            enabled: true,
        },
    ],
    intersections: [
        {
            name: 'X',
            aName: 'c1',
            bName: 'c2',
            aId: 1,
            bId: 2,
            segments: 128,
            color: '#ffffff',
            enabled: true,
        },
    ],
    solves: [],
    odes: [],
    antiderivatives: [],
} as unknown as SceneIR;

/** 显隐按钮回调的落点:测试只关心"点了哪一条",不模拟重新编译. */
interface ToggleCalls {
    entity: number[];
    analysis: string[];
    integral: string[];
    intersection: string[];
    solve: string[];
    antiderivative: string[];
    /** 点过"过程"入口的条目名(过程文档内容另有用例断言). */
    process: string[];
}

function createController(): {
    entityList: StubElement;
    analysisList: StubElement;
    integralList: StubElement;
    intersectionList: StubElement;
    solveList: StubElement;
    calls: ToggleCalls;
    controller: ObjectListController;
} {
    const entityList = new StubElement('div');
    const analysisList = new StubElement('div');
    const integralList = new StubElement('div');
    const intersectionList = new StubElement('div');
    const solveList = new StubElement('div');
    const antiderivativeList = new StubElement('div');
    const calls: ToggleCalls = {
        entity: [],
        analysis: [],
        integral: [],
        intersection: [],
        solve: [],
        antiderivative: [],
        process: [],
    };
    const controller = new ObjectListController(
        {
            entity: entityList as unknown as HTMLElement,
            analysis: analysisList as unknown as HTMLElement,
            integral: integralList as unknown as HTMLElement,
            intersection: intersectionList as unknown as HTMLElement,
            solve: solveList as unknown as HTMLElement,
            antiderivative: antiderivativeList as unknown as HTMLElement,
        },
        {
            toggleEntity: (id) => calls.entity.push(id),
            toggleAnalysis: (name) => calls.analysis.push(name),
            toggleIntegral: (name) => calls.integral.push(name),
            toggleIntersection: (name) => calls.intersection.push(name),
            toggleSolve: (name) => calls.solve.push(name),
            toggleAntiderivative: (name) => calls.antiderivative.push(name),
            // 回调的是过程文档;这里只记题目(内容稳定,不受标题文案改动影响).
            openProcess: (request) => calls.process.push(request.document.problem ?? ''),
        },
    );
    return {
        entityList,
        analysisList,
        integralList,
        intersectionList,
        solveList,
        calls,
        controller,
    };
}

describe('求值条目的折叠结构', () => {
    it('折叠态:彩色标签 + 变量名 + 一行 KaTeX,摘要在 <details> 外层不可复制', () => {
        const { analysisList, controller } = createController();
        controller.renderScene(scene);

        const summary = analysisList.querySelector<StubElement>('.eval-summary')!;
        // 开合交给 <details>/<summary> 原生行为:摘要行就是 <summary>.
        expect(analysisList.querySelectorAll('summary')).toHaveLength(1);
        // 行里唯一一个按钮是行末显隐按钮,且它**不在** summary 内:
        // 点 summary 只开合,点按钮只切换显隐,两者不互相触发.
        const buttons = analysisList.querySelectorAll<StubElement>('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].className).toBe('row-visibility-btn');
        expect(summary.querySelectorAll<StubElement>('.row-visibility-btn')).toHaveLength(0);

        // 彩色类型标签 + 变量名回来了.
        const badge = summary.querySelector<StubElement>('.kind-badge')!;
        expect(badge.className).toBe('kind-badge kind-analysis kind-analysis-gradient');
        expect(badge.textContent).toBe('梯度');
        expect(summary.querySelector<StubElement>('.object-name')!.textContent).toBe('g');

        // 摘要公式不带 data-tex:点摘要行只开合,不复制 TeX.
        const summaryFormula = summary.querySelector<StubElement>('.eval-summary-formula')!;
        expect(summaryFormula.dataset.tex).toBeUndefined();
    });

    it('拉普拉斯条目的彩色标签是"拉普拉斯",类名带 laplacian', () => {
        const { analysisList, controller } = createController();
        controller.renderScene({
            ...scene,
            analyses: [{ ...analysis, op: 'laplacian', symbolic: '\\nabla^2 f=2+2' }],
        });

        const badge = analysisList.querySelector<StubElement>('.kind-badge')!;
        expect(badge.className).toBe('kind-badge kind-analysis kind-analysis-laplacian');
        expect(badge.textContent).toBe('拉普拉斯');
    });

    it('摘要行是 <summary>:点它由浏览器开合,行内没有自建热区', () => {        const { analysisList, controller } = createController();
        controller.renderScene(scene);

        const details = analysisList.querySelector<StubElement>('.eval-details')!;
        const summary = details.children[0] as StubElement;
        expect(summary.tagName).toBe('summary');
        expect(details.open).toBe(false);
        // <details> 的原生开合:浏览器点 summary 会翻 open(桩里手动模拟),
        // 控制器不监听任何 click.
        expect(summary.listeners.get('click')).toBeUndefined();
        details.open = true;
        expect(details.open).toBe(true);
    });

    it('元信息是纯文本块且在公式块之外;就绪后等式只由细节行承载', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        const details = integralList.querySelector<StubElement>('.eval-details')!;
        // 公式块与元信息块是同级兄弟,元信息**不在**公式块里.
        const formulaBlock = details.querySelector<StubElement>('.eval-detail-body')!;
        const metaBlock = details.querySelector<StubElement>('.eval-detail-meta-block')!;
        expect(formulaBlock).toBeDefined();
        expect(metaBlock).toBeDefined();
        expect(formulaBlock.querySelectorAll<StubElement>('.eval-detail-meta')).toHaveLength(0);

        const metas = metaBlock.querySelectorAll<StubElement>('.eval-detail-meta');
        expect(metas.length).toBe(2);
        expect(metas[0].textContent).toContain('域: c1');
        expect(metas[0].textContent).toContain('黎曼和(中点)');
        expect(metas[0].textContent).not.toContain('\\text');
        expect(metas[0].dataset.tex).toBeUndefined();
        expect(metas[1].textContent).toBe('分段: 32 · 分层: 32');

        // 就绪后等式只由细节行承载:公式块里只有一条 `.eval-detail-line`,
        // 不再额外挂一条内容相同的 `.eval-result is-ready`(重复行).
        expect(details.querySelectorAll<StubElement>('.eval-result')).toHaveLength(0);
        const equation = formulaBlock.querySelector<StubElement>('.eval-detail-line')!;
        expect(equation.textContent).toContain('=1.5');
        expect(equation.dataset.tex).toBeDefined();
    });

    it('展开细节的公式行集中在 .eval-detail-body,逐行且可点击复制', () => {
        const { analysisList, controller } = createController();
        controller.renderScene(scene);

        const body = analysisList.querySelector<StubElement>('.eval-detail-body')!;
        const lines = body.querySelectorAll<StubElement>('.eval-detail-line');
        // 梯度:符号展开 / ∇f(P) / P / f(P) 至少 4 行.
        expect(lines.length).toBeGreaterThanOrEqual(4);
        expect(lines[0].textContent).toContain('\\nabla f');
        // 复制只认公式行:每行都带 data-tex(摘要行不带).
        for (const line of lines) {
            expect(line.dataset.tex).toBeDefined();
        }
        // 分析条目没有纯文本元信息,不该凭空出现元信息块.
        expect(analysisList.querySelectorAll<StubElement>('.eval-detail-meta')).toHaveLength(0);
    });

    it('等式与元信息都在 <details> 内,且公式块里没有重复结果行', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 2.775558e-17);

        const details = integralList.querySelector<StubElement>('.eval-details')!;
        const body = details.querySelector<StubElement>('.eval-detail-body')!;
        // 数值等式挂在细节行上;`.eval-result` 就绪态不该再出现一份.
        const equation = body.querySelector<StubElement>('.eval-detail-line')!;
        expect(equation.textContent).toContain('\\mathrm{d}x=');
        expect(equation.textContent).toContain('\\times10^{-17}');
        expect(equation.textContent).not.toContain('e-17');
        expect(body.querySelectorAll<StubElement>('.eval-result')).toHaveLength(0);
        // 折叠态可见的只有 summary 里的那一行公式.
        const summary = details.children[0] as StubElement;
        expect(summary.tagName).toBe('summary');
        expect(summary.querySelectorAll<StubElement>('.eval-detail-body')).toHaveLength(0);
    });
});

describe('行末显隐按钮:隐藏 = 不渲染 + 不参与计算', () => {
    it('实体按钮把 toggleEntity(id) 回调出去,文案是动作', () => {
        const { entityList, calls, controller } = createController();
        controller.renderScene(scene);

        const button = entityList.querySelector<StubElement>('.row-visibility-btn')!;
        expect(button.textContent).toBe('隐藏');
        expect(button.getAttribute('aria-label')).toBe('隐藏 c1');

        button.dispatch('click');
        expect(calls.entity).toEqual([1]);
    });

    it('隐藏的实体:按钮变"显示",行加 is-hidden 并给出状态芯片', () => {
        const { entityList, controller } = createController();
        controller.renderScene({
            ...scene,
            objects: [{ ...curve, enabled: false }],
        } as SceneIR);

        const row = entityList.querySelector<StubElement>('.entity-row')!;
        expect(row.classList.contains('is-hidden')).toBe(true);
        expect(row.querySelector<StubElement>('.row-state')!.textContent).toBe('已隐藏');
        expect(row.querySelector<StubElement>('.row-visibility-btn')!.textContent).toBe('显示');
        // 状态芯片挂在名称行里,与对象名同一行;公式仍是名称行的兄弟(另起一行).
        const head = row.querySelector<StubElement>('.object-head')!;
        expect(head.querySelector<StubElement>('.object-name')).not.toBeNull();
        expect(head.querySelector<StubElement>('.row-state')).not.toBeNull();
        expect(head.querySelector<StubElement>('.object-expr')).toBeNull();
        // 名称行与公式同处主内容包装 `.row-main`(见 rowDom.createObjectRow).
        const main = row.querySelector<StubElement>('.row-main')!;
        expect(head.parent).toBe(main);
        expect(row.querySelector<StubElement>('.object-expr')!.parent).toBe(main);
    });

    it('三类求值对象各自绑到对应的切换入口', () => {
        const {
            analysisList,
            integralList,
            intersectionList,
            calls,
            controller,
        } = createController();
        controller.renderScene(scene);

        analysisList.querySelector<StubElement>('.row-visibility-btn')!.dispatch('click');
        integralList.querySelector<StubElement>('.row-visibility-btn')!.dispatch('click');
        intersectionList.querySelector<StubElement>('.row-visibility-btn')!.dispatch('click');

        expect(calls.analysis).toEqual(['g']);
        expect(calls.integral).toEqual(['I']);
        expect(calls.intersection).toEqual(['X']);
    });

    it('按钮在行末动作容器里,容器不在 <summary> 内,点它不开合细节', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);

        const row = integralList.querySelector<StubElement>('.evaluation-row')!;
        const main = row.querySelector<StubElement>('.row-main')!;
        const summary = row.querySelector<StubElement>('.eval-summary')!;
        const actions = row.querySelector<StubElement>('.row-actions')!;
        const button = row.querySelector<StubElement>('.row-visibility-btn')!;
        expect(summary.tagName).toBe('summary');
        expect(summary.querySelectorAll<StubElement>('.row-visibility-btn')).toHaveLength(0);
        // 行的直接子节点只有"主内容 + 行末动作"两个:摘要/折叠区在主内容里,
        // 动作容器在末位,靠 .row-main 的 flex:1 贴右(见 rowDom.createObjectRow).
        expect(row.children).toHaveLength(2);
        expect(row.children[0]).toBe(main);
        expect(row.children[1]).toBe(actions);
        expect(button.parent).toBe(actions);
        // 签名扩成"行末动作容器"后,显隐按钮仍排在容器**最后一位**,位置语义没变.
        expect(actions.children[actions.children.length - 1]).toBe(button);
        expect(main.querySelector<StubElement>('.eval-details')).not.toBeNull();
        // 行里没有监听 click 的自建开合按钮:开合只认 <summary> 原生行为.
        expect(summary.listeners.get('click')).toBeUndefined();
    });

    it('隐藏的求值条目:按钮变"显示",行加 is-hidden,并给出明文状态', () => {
        const { analysisList, controller } = createController();
        controller.renderScene({
            ...scene,
            analyses: [{ ...analysis, enabled: false }],
        } as SceneIR);

        const row = analysisList.querySelector<StubElement>('.evaluation-row')!;
        expect(row.classList.contains('is-hidden')).toBe(true);
        expect(row.querySelector<StubElement>('.row-visibility-btn')!.textContent).toBe('显示');
        // 隐藏项没有可展开细节,状态行直接可见:不靠透明度传达"不参与计算".
        expect(row.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('已隐藏,不参与计算');
    });
});

describe('列表缓存:内容不变就复用,顺序/展开态/数值都不串', () => {
    it('同一串公式出现两次仍有内容(模板必须 clone,不能搬运)', () => {
        const { entityList, controller } = createController();
        const first: SceneObject = { ...curve, id: 1, name: 'c1' };
        const second: SceneObject = { ...curve, id: 2, name: 'c2' };
        const twoCurves = {
            ...scene,
            objects: [first, second],
            objectFormulas: { 1: 'y=1', 2: 'y=1' },
        } as SceneIR;

        const expressions = (): Array<string | undefined> => entityList
            .querySelectorAll<StubElement>('.object-expr')
            .map((node) => node.textContent);

        // 搬运模板子节点会让第二条空白:缓存模板被第一条搬空了.
        controller.renderScene(twoCurves);
        expect(expressions()).toEqual(['y=1', 'y=1']);

        // 第二次 renderScene:内容变化触发重建,公式必须还能排版出来.
        controller.renderScene({
            ...twoCurves,
            objects: [{ ...first, enabled: false }, second],
        } as SceneIR);
        expect(expressions()).toEqual(['y=1', 'y=1']);
    });

    it('列表顺序跟随场景数组,部分条目重建也不跳位', () => {
        const { analysisList, controller } = createController();
        const first = { ...analysis, name: 'first' };
        const second = { ...analysis, name: 'second' };
        controller.renderScene({ ...scene, analyses: [first, second] } as SceneIR);

        // 只有 first 的内容变化 -> 行被替换;它必须还在 second 前面.
        controller.renderScene({
            ...scene,
            analyses: [{ ...first, scalar: 99 }, second],
        } as SceneIR);

        const names = analysisList
            .querySelectorAll<StubElement>('.object-name')
            .map((node) => node.textContent);
        expect(names).toEqual(['first', 'second']);
    });

    it('条目内容变化导致重建时,<details> 展开态保留', () => {
        const { analysisList, controller } = createController();
        controller.renderScene(scene);
        const before = analysisList.querySelector<StubElement>('details')!;
        before.open = true;

        controller.renderScene({
            ...scene,
            analyses: [{ ...analysis, scalar: 7 }],
        } as SceneIR);

        const after = analysisList.querySelector<StubElement>('details')!;
        expect(after).not.toBe(before);
        expect(after.open).toBe(true);
    });

    it('积分任务被改写后不沿用上一次的数值', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        controller.renderScene({
            ...scene,
            integrals: [{ ...scene.integrals[0], range: [0, 1] as [number, number] }],
        } as SceneIR);

        expect(integralList.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('计算中...');
    });

    it('禁用的积分显示"已隐藏"而不是旧数值', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        controller.renderScene({
            ...scene,
            integrals: [{ ...scene.integrals[0], enabled: false }],
        } as SceneIR);

        expect(integralList.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('已隐藏,不参与计算');
    });

    it('就绪的积分不再产生重复的 .eval-result is-ready', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        const details = integralList.querySelector<StubElement>('.eval-details')!;
        // 公式块里只有一条等式,来自细节行.
        expect(details.querySelectorAll<StubElement>('.eval-detail-line')).toHaveLength(1);
        expect(details.querySelectorAll<StubElement>('.eval-result')).toHaveLength(0);
        expect(details.querySelector<StubElement>('.eval-detail-line')!.textContent)
            .toContain('=1.5');
    });

    it('数值出错时状态行重新挂回公式块,且清掉 data-tex', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);
        // 就绪后状态行已被摘掉:错误路径必须自己把它建回来.
        expect(integralList.querySelector<StubElement>('.eval-result')).toBeNull();

        controller.setIntegralError('I', '计算失败');

        const result = integralList.querySelector<StubElement>('.eval-result')!;
        expect(result.className).toBe('eval-result is-error');
        expect(result.textContent).toBe('计算失败');
        expect(result.dataset.tex).toBeUndefined();
        // 等式退回不带右端的形态,错误文本与等式不再重复同一条公式.
        const equation = integralList.querySelector<StubElement>('.eval-detail-line')!;
        expect(equation.textContent).not.toContain('=1.5');
    });

    it('clear() 连同数值缓存一起清掉,同名任务重建不继承旧值', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        controller.clear();
        controller.renderScene(scene);

        expect(integralList.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('计算中...');
    });

    it('条目从场景里消失后数值缓存随行一起失效', () => {
        const { integralList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntegralResult('I', 1.5);

        // 名字离开场景:DOM 行与数值缓存都必须丢掉,否则 EvaluationSection.results
        // 会变成一个只增不减的 Map(每条历史名字永久留一份数值).
        controller.renderScene({ ...scene, integrals: [] } as SceneIR);
        controller.renderScene(scene);

        expect(integralList.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('计算中...');
    });

    it('求交结果同时报出交点与交线', () => {
        const { intersectionList, controller } = createController();
        controller.renderScene(scene);
        controller.setIntersectionResult('X', {
            points: [{ x: 0, y: 0, z: 0 }],
            curves: [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }]],
        });

        expect(intersectionList.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('c1 ∩ c2 · 交点 1 个 · 交线 1 条');
    });

    it('列表容器与条目带列表语义', () => {
        const { analysisList, controller } = createController();
        controller.renderScene(scene);
        expect(analysisList.getAttribute('role')).toBe('list');
        expect(
            analysisList
                .querySelector<StubElement>('.evaluation-row')!
                .getAttribute('role'),
        ).toBe('listitem');
    });
});

describe('三级披露:长过程的 L2 入口', () => {
    /**
     * 带球坐标回显 + 切向量的梯度 = 6 行细节(符号展开 / 数值 / 取点 / 球坐标 /
     * 函数值 / 切向量),超过 UI_CONFIG.process.disclosureThreshold(5).
     * 这是 `example/sphere_gradient.scad` 里 `at spherical` 那条梯度的形状.
     */
    const longGradient: AnalysisResult = {
        ...analysis,
        name: 'gs',
        pointSpherical: [2, 0.9, 0.6],
        tangent: [0, 0, 1],
    };

    it('细节行超过阈值:出现"过程"入口,点击把过程文档回调出去', () => {
        const { analysisList, calls, controller } = createController();
        controller.renderScene({ ...scene, analyses: [longGradient] } as SceneIR);

        const entry = analysisList.querySelector<StubElement>('.row-process-btn')!;
        expect(entry).not.toBeNull();
        expect(entry.textContent).toBe('过程');
        expect(entry.disabled).toBe(false);

        entry.dispatch('click');
        // 回调的是过程文档本身:题目(待分析的算子式)+ 步骤.
        expect(calls.process).toHaveLength(1);
        expect(calls.process[0]).toBe('\\nabla f\\left(\\left(1,\\ 2,\\ 3\\right)\\right)');
    });

    it('短过程(不超过阈值)不出现"过程"入口,继续留在行内 <details>', () => {
        const { analysisList, controller } = createController();
        controller.renderScene(scene);

        expect(analysisList.querySelectorAll<StubElement>('.row-process-btn')).toHaveLength(0);
        expect(analysisList.querySelector<StubElement>('.eval-details')).not.toBeNull();
    });

    it('一期只接梯度:散度即使带球坐标回显也没有过程入口', () => {
        const { analysisList, controller } = createController();
        controller.renderScene({
            ...scene,
            analyses: [{ ...longGradient, op: 'divergence' }],
        } as SceneIR);

        expect(analysisList.querySelectorAll<StubElement>('.row-process-btn')).toHaveLength(0);
    });

    it('隐藏对象的过程入口置灰并给出明文理由,点击不触发', () => {
        const { analysisList, calls, controller } = createController();
        controller.renderScene({
            ...scene,
            analyses: [{ ...longGradient, enabled: false }],
        } as SceneIR);

        const entry = analysisList.querySelector<StubElement>('.row-process-btn')!;
        expect(entry.disabled).toBe(true);
        // 理由写在 title 与 aria-label 上:鼠标悬停与读屏都能拿到.
        expect(entry.title).toBe('已隐藏,不参与计算');
        expect(entry.getAttribute('aria-label')).toContain('已隐藏,不参与计算');

        entry.dispatch('click');
        expect(calls.process).toEqual([]);
    });
});

describe('方程求解条目', () => {
    const solve: SolveTask = {
        name: 'S',
        equation: 'x^2 - 5*x + 6 = 0',
        variable: 'x',
        equationLatex: 'x^{2}-5x+6=0',
        solutionLatex: 'x = 2 \\quad\\text{或}\\quad x = 3',
        realRootCount: 2,
        identity: false,
        steps: [
            { latex: 'x^{2}-5x+6=0', reason: '原式', kind: 'definition' },
            {
                latex: '\\left(x - 2\\right)\\left(x - 3\\right) = 0',
                reason: '因式分解',
                kind: 'algebra',
            },
            { latex: 'x - 2 = 0 \\quad\\text{或}\\quad x - 3 = 0', reason: '零积律', kind: 'rule' },
            { latex: 'x = 2 \\quad\\text{或}\\quad x = 3', reason: '移项', kind: 'algebra' },
        ],
        error: null,
        enabled: true,
    };

    it('摘要 = 题目:求解标签 + 变量名 + 方程', () => {
        const { solveList, controller } = createController();
        controller.renderScene({ ...scene, solves: [solve] } as SceneIR);

        const row = solveList.querySelector<StubElement>('.evaluation-row')!;
        const badge = row.querySelector<StubElement>('.kind-badge')!;
        expect(badge.className).toBe('kind-badge kind-solve');
        expect(badge.textContent).toBe('求解');
        expect(row.querySelector<StubElement>('.object-name')!.textContent).toBe('S');
        expect(row.querySelector<StubElement>('.eval-summary-formula')!.textContent)
            .toBe('x^{2}-5x+6=0');
    });

    it('展开细节给解集,求解变量与步骤计数', () => {
        const { solveList, controller } = createController();
        controller.renderScene({ ...scene, solves: [solve] } as SceneIR);

        const details = solveList.querySelector<StubElement>('.eval-details')!;
        const lines = details.querySelectorAll<StubElement>('.eval-detail-line');
        expect(lines[0].textContent).toContain('x = 2');
        const metas = details.querySelectorAll<StubElement>('.eval-detail-meta');
        // 求解变量可能是内核推断的,必须写出来;计数把读者引到过程页.
        expect(metas[0].textContent).toBe('求解 x: 共 4 步(见右栏"过程")');
    });

    it('过程入口可用并回调过程文档;显隐按钮回调 toggleSolve', () => {
        const { solveList, calls, controller } = createController();
        controller.renderScene({ ...scene, solves: [solve] } as SceneIR);

        const entry = solveList.querySelector<StubElement>('.row-process-btn')!;
        expect(entry.disabled).toBe(false);
        entry.dispatch('click');
        // 题目就是待求解的方程(不是条目名).
        expect(calls.process).toEqual(['x^{2}-5x+6=0']);

        solveList.querySelector<StubElement>('.row-visibility-btn')!.dispatch('click');
        expect(calls.solve).toEqual(['S']);
    });

    it('隐藏项:摘要回退方程原文,入口置灰并给理由', () => {
        const { solveList, controller } = createController();
        controller.renderScene({
            ...scene,
            solves: [{
                ...solve,
                enabled: false,
                equationLatex: '',
                solutionLatex: null,
                steps: [],
            }],
        } as SceneIR);

        const row = solveList.querySelector<StubElement>('.evaluation-row')!;
        expect(row.classList.contains('is-hidden')).toBe(true);
        // 没有题目 LaTeX 时回退成方程原文(纯文本),不留半条公式.
        expect(row.querySelector<StubElement>('.object-expr')!.textContent)
            .toBe('x^2 - 5*x + 6 = 0');
        expect(row.querySelector<StubElement>('.eval-result')!.textContent)
            .toBe('已隐藏,不参与计算');
        const entry = row.querySelector<StubElement>('.row-process-btn')!;
        expect(entry.disabled).toBe(true);
        expect(entry.getAttribute('aria-label')).toContain('已隐藏,不参与计算');
    });

    it('内核拒绝的方程:细节写明理由,过程入口置灰', () => {
        const { solveList, controller } = createController();
        controller.renderScene({
            ...scene,
            solves: [{
                ...solve,
                error: '求解内核目前只支持一次/二次方程,当前方程的次数是 3;三次以上留待后续分期',
                equationLatex: '',
                solutionLatex: null,
                steps: [],
            }],
        } as SceneIR);

        const row = solveList.querySelector<StubElement>('.evaluation-row')!;
        expect(row.querySelector<StubElement>('.eval-detail-meta')!.textContent)
            .toContain('无法求解');
        const entry = row.querySelector<StubElement>('.row-process-btn')!;
        expect(entry.disabled).toBe(true);
        expect(entry.getAttribute('aria-label')).toContain('无法求解');
    });
});
