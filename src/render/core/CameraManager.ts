import * as THREE from 'three';
import { RENDER_CONFIG, type UpAxis } from '../../config/renderConfig';
import type { CamMode, ViewHome } from '../../types';
// OrbitControls 没有独立类型包,从 three/examples 导入类型
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** 三条坐标轴的正方向(单位向量). */
const UP_VECTORS: Record<UpAxis, readonly [number, number, number]> = {
    x: [1, 0, 0],
    y: [0, 1, 0],
    z: [0, 0, 1],
};

/**
 * 预设视角的观察方向(相机从该方向看向原点).
 *
 * top/bottom 永远沿"向上轴";其余轴按右手系 (right, up, front) 推导,
 * 保证切换向上轴后"上/前/右"仍然是一套自洽的坐标习惯:
 * - Y 向上(Three.js/图形):right = X,front = Z;
 * - Z 向上(数学/工程):right = X,front = -Y;
 * - X 向上(少数工程/地理工具):right = Y,front = -Z.
 */
const VIEW_DIRECTIONS: Record<
    UpAxis,
    Record<'top' | 'bottom' | 'front' | 'back' | 'left' | 'right', readonly [number, number, number]>
> = {
    x: {
        top: [1, 0, 0],
        bottom: [-1, 0, 0],
        front: [0, 0, -1],
        back: [0, 0, 1],
        right: [0, 1, 0],
        left: [0, -1, 0],
    },
    y: {
        top: [0, 1, 0],
        bottom: [0, -1, 0],
        front: [0, 0, 1],
        back: [0, 0, -1],
        right: [1, 0, 0],
        left: [-1, 0, 0],
    },
    z: {
        top: [0, 0, 1],
        bottom: [0, 0, -1],
        front: [0, -1, 0],
        back: [0, 1, 0],
        right: [1, 0, 0],
        left: [-1, 0, 0],
    },
};

/**
 * 相机管理器
 * - 管理透视/正交投影切换
 * - 管理 ViewCube 的预置观察方向
 * - 管理旋转锁定(平移和缩放保持可用)
 */
export class CameraManager {
    container: HTMLElement;
    aspect: number;

    perspCamera: THREE.PerspectiveCamera;
    orthoCamera: THREE.OrthographicCamera;
    activeCamera: THREE.Camera;
    mode: CamMode;
    currentHome: ViewHome;
    controls: OrbitControls | null;

    /** 当前"正方向朝上"的轴. */
    private upAxis: UpAxis;
    private readonly upVector = new THREE.Vector3();
    /**
     * 记住旋转锁定状态并回填到 OrbitControls.
     *
     * 锁定开关的初始状态可能早于 OrbitControls 创建(或切换向上轴时重建),
     * 只写一次 `controls.enableRotate` 会与锁定态脱钩.
     */
    private rotationLocked = false;

    constructor(container: HTMLElement) {
        this.container = container;
        this.aspect = this.container.clientWidth / this.container.clientHeight;

        this.upAxis = RENDER_CONFIG.scene.upAxis;
        this.upVector.set(...UP_VECTORS[this.upAxis]);

        this.perspCamera = new THREE.PerspectiveCamera(
            RENDER_CONFIG.camera.perspFov,
            this.aspect,
            RENDER_CONFIG.camera.near,
            RENDER_CONFIG.camera.far,
        );
        this.perspCamera.up.copy(this.upVector);
        this.perspCamera.position.set(...RENDER_CONFIG.camera.defaultPosition as [number, number, number]);
        this.perspCamera.lookAt(...RENDER_CONFIG.camera.initViewTarget as [number, number, number]);

        const half = RENDER_CONFIG.camera.frustumSize / 2;
        this.orthoCamera = new THREE.OrthographicCamera(
            -half * this.aspect, half * this.aspect,
            half, -half,
            RENDER_CONFIG.camera.near, RENDER_CONFIG.camera.far,
        );
        this.orthoCamera.up.copy(this.upVector);
        this.orthoCamera.position.set(...RENDER_CONFIG.camera.defaultPosition as [number, number, number]);
        this.orthoCamera.lookAt(...RENDER_CONFIG.camera.initViewTarget as [number, number, number]);

        this.mode = RENDER_CONFIG.camera.defaultMode;
        this.currentHome = RENDER_CONFIG.camera.defaultHome;
        this.controls = null;
        // 初始激活相机必须与 mode 一致:两台相机都已按默认机位取景,
        // 这里只挑选对应的一台(默认正交时若仍选透视相机就会渲染错相机).
        this.activeCamera = this._cameraFor(this.mode);
    }

    setControls(controls: OrbitControls): void {
        this.controls = controls;
        if (this.controls) {
            this.controls.object = this.activeCamera;
            this.controls.target.set(...RENDER_CONFIG.camera.initViewTarget as [number, number, number]);
            this.controls.enableRotate = !this.rotationLocked;
            this.controls.update();
        }
    }

    /**
     * 切换透视/正交投影.
     *
     * 只替换 activeCamera 并同步新相机的视锥/aspect:两台相机各自持有
     * position/quaternion,这里把当前视角原样带过去,也不动 `controls.target`,
     * 因此旋转/平移后的观察姿态不会被拉回预置机位.
     *
     * 重新取景只属于 `setView` / `setUpAxis`(它们是"换机位"语义).
     * 正交 zoom 同样保留:它是用户在当前投影下的缩放状态,和保留下来的
     * 机位一起才自洽,不应在往返切换后被清掉.
     */
    setCameraMode(mode: CamMode): void {
        if (mode === this.mode) return;
        this.mode = mode;
        this._activateCamera();
    }

    setView(home: ViewHome): void {
        this.currentHome = home;
        this._applyView();
    }

    /**
     * 切换"正方向朝上"的轴,并立即按当前预设视角重新取景.
     *
     * @returns 是否真的发生了切换(用于调用方决定是否重建 OrbitControls).
     */
    setUpAxis(axis: UpAxis): boolean {
        if (axis === this.upAxis) return false;
        this.upAxis = axis;
        this.upVector.set(...UP_VECTORS[axis]);
        this._applyView();
        return true;
    }

    /** 释放并解绑 OrbitControls,供切换向上轴后重建. */
    detachControls(): void {
        this.controls?.dispose();
        this.controls = null;
    }

    setRotationLock(locked: boolean): void {
        this.rotationLocked = locked;
        if (this.controls) {
            this.controls.enableRotate = !locked;
        }
    }

    updateAspect(width: number, height: number): void {
        this.aspect = width / height;
        // 只同步当前激活相机;另一台在投影切换时会被 _activateCamera 同步.
        this._syncProjection(this.activeCamera);
    }

    getCamera(): THREE.Camera {
        return this.activeCamera;
    }

    /** 投影模式与相机实例的对应关系(参数类型放宽为 CamMode,避免字面量收窄). */
    private _cameraFor(mode: CamMode): THREE.Camera {
        return mode === 'perspective' ? this.perspCamera : this.orthoCamera;
    }

    dispose(): void {
        this.detachControls();
    }

    /**
     * 只切换 activeCamera:把当前相机的姿态原样交给目标相机,再同步投影参数.
     * 不改变机位,不改变 controls.target.
     */
    private _activateCamera(): void {
        const previous = this.activeCamera;
        const next = this._cameraFor(this.mode);
        if (previous !== next) {
            next.position.copy(previous.position);
            next.quaternion.copy(previous.quaternion);
            next.up.copy(previous.up);
        }
        this._syncProjection(next);
        this.activeCamera = next;

        if (this.controls) {
            this.controls.object = next;
            this.controls.update();
        }
    }

    /** 按当前 aspect 同步一台相机的投影参数(不动 zoom / 机位). */
    private _syncProjection(camera: THREE.Camera): void {
        if (camera instanceof THREE.PerspectiveCamera) {
            camera.aspect = this.aspect;
        } else if (camera instanceof THREE.OrthographicCamera) {
            const half = RENDER_CONFIG.camera.frustumSize / 2;
            camera.left = -half * this.aspect;
            camera.right = half * this.aspect;
            camera.top = half;
            camera.bottom = -half;
        }
        (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }

    private _applyView(): void {
        const target = new THREE.Vector3(0, 0, 0);
        const pos = this.currentHome === 'isometric'
            ? new THREE.Vector3(
                ...RENDER_CONFIG.camera.defaultPosition as [number, number, number],
            )
            : this._homePosition(this.currentHome);

        if (this.mode === 'perspective') {
            this.perspCamera.up.copy(this.upVector);
            this.perspCamera.position.copy(pos);
            this.perspCamera.lookAt(target);
            this.activeCamera = this.perspCamera;
        } else {
            this.orthoCamera.position.copy(pos);
            this.orthoCamera.up.copy(this.upVector);
            this.orthoCamera.lookAt(target);
            this.activeCamera = this.orthoCamera;
        }
        this._syncProjection(this.activeCamera);

        if (this.controls) {
            this.controls.object = this.activeCamera;
            this.controls.target.copy(target);
            this.controls.update();
        }
    }

    /** 计算 top/bottom/front/back/left/right 预设视角的相机位置. */
    private _homePosition(
        home: Exclude<ViewHome, 'isometric'>,
    ): THREE.Vector3 {
        const direction = VIEW_DIRECTIONS[this.upAxis][home];
        const distance = RENDER_CONFIG.camera.viewDistance;
        return new THREE.Vector3(
            direction[0] * distance,
            direction[1] * distance,
            direction[2] * distance,
        );
    }
}
