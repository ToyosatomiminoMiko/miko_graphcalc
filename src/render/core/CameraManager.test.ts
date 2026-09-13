import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CameraManager } from './CameraManager';
import { RENDER_CONFIG } from '../../config/renderConfig';

/** CameraManager 只读取容器的像素尺寸,不需要真实 DOM. */
const viewport = { clientWidth: 800, clientHeight: 600 } as HTMLElement;

/** 投影模式对应的 THREE 相机 type 字符串. */
function cameraType(mode: 'perspective' | 'orthographic'): string {
    return mode === 'perspective' ? 'PerspectiveCamera' : 'OrthographicCamera';
}

/** 装一个够用的 OrbitControls 桩,只观察 target/object/enableRotate. */
function attachControls(manager: CameraManager) {
    const controls = {
        object: manager.getCamera(),
        target: new THREE.Vector3(),
        enableRotate: true,
        update: () => {},
        dispose: () => {},
    };
    manager.setControls(controls as never);
    return controls;
}

describe('CameraManager', () => {
    it('初始激活相机与配置的 defaultMode 一致', () => {
        const manager = new CameraManager(viewport);

        expect(manager.mode).toBe(RENDER_CONFIG.camera.defaultMode);
        // 关键不变式:mode 说是正交,渲染用的就必须是正交相机
        expect(manager.getCamera().type).toBe(cameraType(manager.mode));
    });

    it('切换投影模式后激活相机随之改变', () => {
        const manager = new CameraManager(viewport);
        const before = manager.getCamera();
        const next = manager.mode === 'perspective' ? 'orthographic' : 'perspective';

        manager.setCameraMode(next);

        expect(manager.getCamera()).not.toBe(before);
        expect(manager.getCamera().type).toBe(cameraType(next));
    });

    it('切换投影保留当前机位,朝向与 pan target(RND-P2.6)', () => {
        const manager = new CameraManager(viewport);
        const controls = attachControls(manager);

        manager.activeCamera.position.set(5, 5, 5);
        manager.activeCamera.quaternion.setFromEuler(new THREE.Euler(0.3, 0.4, 0.5));
        controls.target.set(5, 6, 7);
        const quaternion = manager.activeCamera.quaternion.clone();

        const next = manager.mode === 'perspective' ? 'orthographic' : 'perspective';
        manager.setCameraMode(next);

        expect(manager.getCamera().position.toArray()).toEqual([5, 5, 5]);
        expect(manager.getCamera().quaternion.angleTo(quaternion)).toBeCloseTo(0, 6);
        expect(controls.target.toArray()).toEqual([5, 6, 7]);
        // 新激活相机仍然与 controls 绑定
        expect(controls.object).toBe(manager.getCamera());
    });

    it('往返切换投影不会重置正交 zoom 与 frustum(RND-P3.3)', () => {
        const manager = new CameraManager(viewport);
        attachControls(manager);

        manager.orthoCamera.zoom = 3;
        manager.setCameraMode('perspective');
        manager.setCameraMode('orthographic');

        expect(manager.orthoCamera.zoom).toBe(3);
        const half = RENDER_CONFIG.camera.frustumSize / 2;
        expect(manager.orthoCamera.top).toBe(half);
        expect(manager.orthoCamera.bottom).toBe(-half);
        expect(manager.orthoCamera.left).toBeCloseTo(-half * manager.aspect, 6);
        expect(manager.orthoCamera.right).toBeCloseTo(half * manager.aspect, 6);
    });

    it('旋转锁定状态会回填到(后创建/重建的)OrbitControls', () => {
        const manager = new CameraManager(viewport);
        manager.setRotationLock(true);

        const controls = attachControls(manager);
        expect(controls.enableRotate).toBe(false);

        manager.setRotationLock(false);
        expect(controls.enableRotate).toBe(true);

        // 模拟切换向上轴后重建:锁定态仍然生效
        manager.setRotationLock(true);
        manager.detachControls();
        const rebuilt = attachControls(manager);
        expect(rebuilt.enableRotate).toBe(false);
    });

    it('setView 仍然按预置机位重新取景', () => {
        const manager = new CameraManager(viewport);
        const controls = attachControls(manager);
        manager.activeCamera.position.set(5, 5, 5);
        controls.target.set(5, 6, 7);

        manager.setView('front');

        expect(manager.currentHome).toBe('front');
        expect(controls.target.toArray()).toEqual([0, 0, 0]);
        expect(manager.activeCamera.position.length())
            .toBeCloseTo(RENDER_CONFIG.camera.viewDistance, 6);
    });
});
