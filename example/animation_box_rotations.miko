// =============================================================
// 动画示例:每次只给一个矩阵,复杂动画用列表按顺序播放
// =============================================================

// 三个旋转动画片段:绕 z / y / x 轴各转 pi
animation rot1 = rotate([0, 0, pi]) {
    duration = 3;
};
animation rot2 = rotate([0, pi, 0]) {
    duration = 3;
};
animation rot3 = rotate([pi, 0, 0]) {
    duration = 3;
};

// 方块按 [rot1, rot2, rot3] 顺序播放
box B = [0, 0, 0] {
    size = [1, 1, 1];
    color = "#ff6b8a";
    animation = [rot1, rot2, rot3];
};
