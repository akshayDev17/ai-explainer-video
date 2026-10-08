window.SCENE_CONFIG = { renderAt: function (t, svg) {
  SceneCore.primitives.equation(svg, { tex: 'P(k) = \\frac{(\\lambda t)^k e^{-\\lambda t}}{k!}',
    y: 300, size: 52, at: 0 }, t);
  SceneCore.primitives.equation(svg, { tex: 'a \\to b \\iff V[a] < V[b]',
    y: 470, size: 48, at: 0.2 }, t);
  SceneCore.primitives.equation(svg, { tex: 'V = \\sqrt{x^2 + y_{i}^{2}} \\ge \\lceil z \\rceil',
    y: 640, size: 48, at: 0.4 }, t);
  SceneCore.primitives.equation(svg, { tex: 'merged[i] = \\max(A[i], B[i])',
    y: 800, size: 44, at: 0.6 }, t);
} };
