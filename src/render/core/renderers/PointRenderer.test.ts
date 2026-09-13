import { describe, expect, it } from 'vitest';
import { PointRenderer } from './PointRenderer';
import type { PointObject } from '../../../compiler/ir/types';

function pointObject(overrides: Partial<PointObject> = {}): PointObject {
    return {
        kind: 'point',
        id: 1,
        expr: '[0, 0, 0]',
        x: 0,
        y: 0,
        z: 0,
        color: '#ffffff',
        enabled: true,
        ...overrides,
    };
}

describe('PointRenderer 可见性(RND-P2.4)', () => {
    it('setVisible(false) 后 setStyle 不会让点复活', () => {
        const renderer = new PointRenderer(pointObject(), { radius: 0.2, visible: true });
        renderer.draw();
        expect(renderer.group.visible).toBe(true);

        renderer.setVisible(false);
        expect(renderer.group.visible).toBe(false);
        expect(renderer.visible).toBe(false);

        renderer.setStyle({ radius: 0.35, visible: true });
        // 关键不变式:对象列表的隐藏状态被记住,不因样式刷新丢失
        expect(renderer.group.visible).toBe(false);
        expect(renderer.visible).toBe(false);

        renderer.dispose();
    });

    it('全局点隐藏时 draw 也不显示', () => {
        const renderer = new PointRenderer(pointObject(), { radius: 0.2, visible: false });
        renderer.draw();
        expect(renderer.group.visible).toBe(false);

        renderer.setStyle({ radius: 0.2, visible: true });
        expect(renderer.group.visible).toBe(true);

        renderer.dispose();
    });

    it('引用换成 enabled=false 的实例后,setStyle 仍保持隐藏', () => {
        const renderer = new PointRenderer(pointObject(), { radius: 0.2, visible: true });
        renderer.draw();

        // 模拟 commitSceneWithoutRedraw 换新实例:renderer 同步到新引用
        renderer.updateRef(pointObject({ enabled: false }));
        renderer.setVisible(false);

        renderer.setStyle({ radius: 0.5, visible: true });
        expect(renderer.group.visible).toBe(false);

        renderer.dispose();
    });

    it('draw 按最新对象引用同步可见性', () => {
        const renderer = new PointRenderer(pointObject(), { radius: 0.2, visible: true });
        renderer.draw();
        renderer.setVisible(false);
        expect(renderer.group.visible).toBe(false);

        // 重新运行/对象列表恢复显示时会走 setVisible + draw
        renderer.setVisible(true);
        renderer.draw();
        expect(renderer.group.visible).toBe(true);

        renderer.updateRef(pointObject({ enabled: false }));
        renderer.draw();
        expect(renderer.group.visible).toBe(false);

        renderer.dispose();
    });
});
