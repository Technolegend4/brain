/* nav.js —— 让同一套页面既能单独打开，也能装进单文件外壳的 iframe 里。
 *
 * 单独打开（window.parent === window）：链接正常跳转，什么都不做。
 * 在 iframe 里（单文件版外壳）：拦截页面内到其它页的链接，向父窗口发
 *   {nav: "explore"} 这样的消息，由外壳切换 iframe，避免整页重新加载。
 */
(function () {
  'use strict';

  // 页面文件名 → 外壳里的 key。新增页面时在这里登记。
  var MAP = {
    'home.html': 'home',
    'explore.html': 'explore',
    'connect.html': 'connect',
    'lab.html': 'lab'
  };

  var inFrame = false;
  try { inFrame = window.parent && window.parent !== window; } catch (e) { inFrame = false; }
  if (!inFrame) return;   // 单独打开：交给浏览器默认行为

  function navigate(target) {
    var key = MAP[target];
    if (!key) return false;
    parent.postMessage({ nav: key }, '*');
    return true;
  }

  // 暴露给页面自己的 JS 用（如首页星图入口、游戏开始按钮）
  window.auroraNav = navigate;
  window.auroraInFrame = true;

  // 捕获阶段拦截所有指向本组页面的 <a>
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    // 剥掉 query / hash，只比较文件名
    var file = href.split('#')[0].split('?')[0].split('/').pop();
    if (navigate(file)) e.preventDefault();
  }, true);
})();
