import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from './AnimationPlayer';
import { jsMatrixOps } from '../../math/tensor/testMatrixOps';

const identity = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
];

describe('AnimationPlayer', () => {
    it('returns the base transform before any clip starts', () => {
        const player = new AnimationPlayer(jsMatrixOps);
        player.setScene(
            { 1: identity },
            [],
            {},
        );

        expect(player.getObjectMatrix(1, 0)).toEqual(identity);
    });

    it('interpolates a single translation clip over its duration', () => {
        const player = new AnimationPlayer(jsMatrixOps);
        player.setScene(
            {},
            [{
                name: 'move',
                duration: 1,
                matrix: [
                    [1, 0, 0, 1],
                    [0, 1, 0, 0],
                    [0, 0, 1, 0],
                    [0, 0, 0, 1],
                ],
            }],
            { 1: ['move'] },
        );

        const start = player.getObjectMatrix(1, 0)!;
        const middle = player.getObjectMatrix(1, 0.5)!;
        const end = player.getObjectMatrix(1, 1)!;

        expect(start[0][3]).toBeCloseTo(0);
        expect(middle[0][3]).toBeCloseTo(0.5);
        expect(end[0][3]).toBeCloseTo(1);
    });

    it('chains clips from the matrix left by the previous clip', () => {
        const player = new AnimationPlayer(jsMatrixOps);
        player.setScene(
            {},
            [
                {
                    name: 'right',
                    duration: 1,
                    matrix: [
                        [1, 0, 0, 1],
                        [0, 1, 0, 0],
                        [0, 0, 1, 0],
                        [0, 0, 0, 1],
                    ],
                },
                {
                    name: 'up',
                    duration: 1,
                    matrix: [
                        [1, 0, 0, 0],
                        [0, 1, 0, 2],
                        [0, 0, 1, 0],
                        [0, 0, 0, 1],
                    ],
                },
            ],
            { 1: ['right', 'up'] },
        );

        const firstClipEnd = player.getObjectMatrix(1, 1)!;
        const secondClipMiddle = player.getObjectMatrix(1, 1.5)!;
        const final = player.getObjectMatrix(1, 2)!;

        expect(firstClipEnd[0][3]).toBeCloseTo(1);
        expect(firstClipEnd[1][3]).toBeCloseTo(0);
        expect(secondClipMiddle[0][3]).toBeCloseTo(1);
        expect(secondClipMiddle[1][3]).toBeCloseTo(1);
        expect(final[0][3]).toBeCloseTo(1);
        expect(final[1][3]).toBeCloseTo(2);
    });
});
