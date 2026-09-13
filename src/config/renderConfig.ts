/**
 * 渲染与可视化常量.
 *
 * 这里只放静态默认值,不包含几何体实例或 Three.js 对象.
 * 相机与视图默认值统一放在 `camera`,场景(坐标轴/网格/点)放在 `scene`.
 */

/** 坐标轴向上:正方向朝上的轴,兼容不同学科/工具习惯. */
export type UpAxis = 'x' | 'y' | 'z';

export const RENDER_CONFIG = {
    integralVisualizer: {
        barGap: 0.05,
        depth2D: 0.3,
        opacityRiemann: 0.5,
        opacityLebesgue: 0.5,
        edgeOpacityRiemann: 0.4,
    },
    volume: {
        defaultOpacity: 0.55,
        defaultEdgeOpacity: 0.3,
    },
    vectorFieldMesh: {
        threshold: 1e-8,
        shaftRadius: 0.05,
        headRadius: 0.15,
        headLengthRatio: 0.2,
        radialSegments: 8,
        roughness: 0.6,
        metalness: 0.2,
    },
    arrowMesh: {
        shaftRadius: 0.08,
        headRadius: 0.2,
        headLength: 0.4,
        zeroLengthThreshold: 1e-6,
        radialSegments: 8,
    },
    analysis: {
        arrowLength: 1.5,
        arrowHeadLength: 0.2,
        arrowHeadWidth: 0.1,
        // 一元曲线求导(show = tangent)切线的 x 向半长:以分析点为
        // 中心沿切向 (1, f', 0) 左右各延伸 Δx = 该值(Δy 随斜率自然放大).
        tangentHalfLength: 2,
        tangentPlaneSize: 1.6,
        tangentPlaneOpacity: 0.55,
        tolerance: 1e-12,
        // 分析测量点(show = point)不再自设半径:与场景 point 对象共用
        // scene.point 的半径/可见(右侧"点"面板统一控制).
    },
    intersection: {
        pointSize: 0.18,
        lineWidth: 2,
    },
    surfaceMesh: {
        defaultSegments: 128,
        materialOpacity: 0.85,
        shininess: 30,
        specular: 0x222244,
        wireframeColor: 0x88aaff,
        wireframeOpacity: 0.15,
        // 曲面线框网格默认显示(叠加在曲面上的采样网格),旧行为一致.
        wireframeVisible: true,
        // z->HSL 伪彩色映射默认启用;关闭后曲面显示自身基色(对象 color).
        colorMapEnabled: true,
    },
    // 相机与视图默认值:投影模式,初始机位与视锥参数,由 CameraManager 读取.
    // defaultMode 同时是投影切换 UI(CameraToggle)的初态,避免两处默认值漂移.
    camera: {
        defaultMode: 'orthographic' as const,
        frustumSize: 14,
        initViewTarget: [0, 0, 0] as readonly number[],
        defaultPosition: [12, 8, 12] as readonly number[],
        defaultHome: 'isometric' as const,
        viewDistance: 20,
        perspFov: 45,
        near: 0.1,
        far: 200,
    },
    // 坐标轴XYZ设置
    scene: {
        background: 0x111122,
        // 哪个轴的正方向朝上,默认 Z(数学/工程习惯);Y 是 Three.js 等图形工具习惯
        upAxis: 'z' as UpAxis,
        // 坐标轴范围
        axesLength: 10,
        // 坐标轴标签位置
        axisLabelLength: 11,
        // Line2 坐标轴线宽(像素),可在右侧"视图"面板调整
        axisLineWidth: 3,
        // 网格:大刻度线粗,小刻度线细,均用 Line2 系列绘制
        grid: {
            size: 20,
            majorStep: 5,
            minorStep: 1,
            // π 单位模式下的步长:大刻度 π,小刻度 π/2,于是网格线与刻度
            // 落在 π/2 的整数倍上(标签 π/2,π,3π/2 ...),而不是给旧的
            // 整数刻度换数字.由"坐标轴"面板的 π 单位开关切换.
            piMajorStep: Math.PI,
            piMinorStep: Math.PI / 2,
            majorColor: 0x555566,
            minorColor: 0x2e2e3d,
            majorLineWidth: 1.5,
            minorLineWidth: 0.75,
            // 三个坐标平面各自独立显隐
            planes: {
                xz: true,
                xy: true,
                yz: true,
            },
        },
        // 坐标轴刻度线(大刻度长/粗,小刻度短/细)
        axisTicks: {
            majorLength: 0.22,
            minorLength: 0.1,
            color: 0x8899aa,
            // 刻度数字与 XYZ 轴标签共用 labelFont/labelCanvasSize/labelScale
            labelColor: '#9fb2d8',
            labelOffset: 0.35,
            // 刻度数字显示单位:false 普通数值;true 时网格/刻度改按 π 步长
            // 重排,数字显示为 π 的整数/简单分数倍,可在右侧"坐标轴"面板切换.
            piUnit: false,
            visible: true,
        },
        // 各轴标签(隐藏标签时同步隐藏该轴的刻度数字)
        axisLabels: {
            x: true,
            y: true,
            z: true,
        },
        // 点(场景 point 对象 + 分析测量点共用同一定义):全局渲染样式,
        // 大小(可设置具体值)/比例缩放/可见性,由右侧"点"面板统一控制.
        // 比例只是半径的另一种显示方式(默认 1 即 100%),没有独立的配置项.
        point: {
            radius: 0.2,
            visible: true,
        },
        labelCanvasSize: 64,
        labelFont: 'Bold 36px Arial',
        labelScale: 0.8,
        // 坐标轴颜色 (行业惯例)
        axisColors: {
            x: '#ff4444',
            y: '#44ff44',
            z: '#4488ff',
        },
    },
};
