# -*- coding: utf-8 -*-
"""把 src/ 下的四个页面打包成单文件 Aurora_Voyage.html（外壳 + iframe srcdoc）。

用法：
    python build_merged.py              # 读取 src/，输出到项目根目录
    python build_merged.py --out out.html

源目录结构（随仓库一起提交，不依赖任何本机绝对路径）：
    src/home.html     首页（星图）
    src/explore.html  沉浸浏览
    src/connect.html  关于与反馈
    src/lab.html      脑波实验室（眨眼游戏）
    src/nav.js        导航脚本（单文件版会内联进每个页面）

单文件版的工作方式：
    - 四个页面以 HTML 字符串形式内嵌到外壳的 PAGES 对象里
    - 外壳用 <iframe srcdoc> 按需加载，切换页面不整页刷新
    - 每个页面注入 nav.js：点击指向本组页面的链接时，向父窗口发 {nav:key}
    - 实验室页不能直连本机 WebSocket（iframe + 本地网络策略），由外壳代连后转发
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
DEFAULT_OUT = os.path.join(HERE, "Aurora_Voyage.html")

# key -> 文件名。新增页面时在这里登记，nav.js 里也要加同名条目。
PAGES = {
    "home": "home.html",
    "explore": "explore.html",
    "connect": "connect.html",
    "lab": "lab.html",
}

SHELL_HEAD = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aurora Voyage · 星海航行计划</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#05060c;overflow:hidden}
  iframe{position:fixed;inset:0;width:100%;height:100%;border:0;display:none;background:#05060c}
  iframe.on{display:block}
</style>
</head>
<body>
<script>
"""

SHELL_TAIL = """
</script>
</body>
</html>
"""

ROUTER_JS = """
var ORDER = %(order)s;
var FMAP = %(fmap)s;

function show(k){
  var fr=document.querySelectorAll("iframe");
  for(var i=0;i<fr.length;i++)fr[i].classList.remove("on");
  var f=document.getElementById("pg-"+k);
  if(!f){
    f=document.createElement("iframe");
    f.id="pg-"+k;
    f.setAttribute("allow","autoplay");
    f.srcdoc=PAGES[k];
    document.body.appendChild(f);
  }
  f.classList.add("on");
  current=k;
}
function route(){
  var k=(location.hash||"#home").slice(1);
  if(ORDER.indexOf(k)<0)k="home";
  show(k);
}
window.addEventListener("hashchange",route);

window.addEventListener("message",function(e){
  var d=e.data||{};
  // 只接受来自当前实验室 iframe 的消息
  var lab=labFrame();
  if(lab && e.source!==lab.contentWindow) return;

  var nav=d.nav;
  if(nav){
    nav=FMAP[nav]||nav;
    if(ORDER.indexOf(nav)>=0&&location.hash!=="#"+nav)location.hash=nav;
    return;
  }
  // 实验室 iframe 无法直连本机 WebSocket（浏览器本地网络限制），由外壳代连并转发
  if(d.wsCmd==="open"){relayOpen(d.url);}
  else if(d.wsCmd==="close"){relayClose();}
});

var current=null,wsConn=null,wsLastMsg=0,wsWatch=null;
function labFrame(){return document.getElementById("pg-lab");}
function postLab(o){var f=labFrame();if(f&&f.contentWindow)f.contentWindow.postMessage(o,"*");}

function relayOpen(url){
  // 重连前先收掉旧的心跳定时器，否则每重连一次就多一条 interval 常驻
  if(wsWatch){clearInterval(wsWatch);wsWatch=null;}
  try{
    if(wsConn&&wsConn.readyState<=1){try{wsConn.close();}catch(e){}}
    wsLastMsg=0;
    wsConn=new WebSocket(url||"ws://127.0.0.1:7000");
    wsConn.onopen=function(){wsLastMsg=Date.now();postLab({wsState:"open"});};
    wsConn.onerror=function(){postLab({wsState:"error"});};
    wsConn.onclose=function(){postLab({wsState:"close"});};
    wsConn.onmessage=function(ev){wsLastMsg=Date.now();postLab({wsData:ev.data});};
    // 心跳看门狗：曾经收到过数据、现在超过 9 秒静默 → 连接已半死，主动断开触发重连
    wsWatch=setInterval(function(){
      if(!wsConn)return;
      if(wsConn.readyState===1&&wsLastMsg&&Date.now()-wsLastMsg>9000){
        try{wsConn.close();}catch(e){}
      }
    },2500);
  }catch(err){postLab({wsState:"error"});}
}

function relayClose(){
  if(wsWatch){clearInterval(wsWatch);wsWatch=null;}
  try{if(wsConn)wsConn.close();}catch(e){}
  wsConn=null;wsLastMsg=0;
}

route();
"""


def read_page(path):
    if not os.path.exists(path):
        sys.exit(
            "缺少源文件：%s\n"
            "请确认 src/ 目录完整（home.html / explore.html / connect.html / lab.html / nav.js）。" % path
        )
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def inline_nav(html, nav_js):
    """把 <script src="nav.js"> 替换成内联脚本，让单文件版不依赖外部文件。"""
    pattern = re.compile(r'\s*<script\s+src=["\']nav\.js["\']\s*>\s*</script>', re.I)
    inline = "\n<script>\n%s\n</script>\n" % nav_js
    if not pattern.search(html):
        # 没有引用 nav.js 就追加到 </body> 前，保证导航拦截一定生效
        idx = html.lower().rfind("</body>")
        return html[:idx] + inline + html[idx:] if idx >= 0 else html + inline
    return pattern.sub(inline, html, count=1)


def main():
    ap = argparse.ArgumentParser(description="打包 Aurora Voyage 单文件版")
    ap.add_argument("--out", default=DEFAULT_OUT, help="输出文件路径")
    ap.add_argument("--src", default=SRC, help="源目录（默认 ./src）")
    args = ap.parse_args()

    nav_js = read_page(os.path.join(args.src, "nav.js"))

    packed = {}
    for key, fname in PAGES.items():
        html = read_page(os.path.join(args.src, fname))
        html = inline_nav(html, nav_js)
        s = json.dumps(html, ensure_ascii=False)
        s = s.replace("</", "<\\/")   # 防止内嵌的 </script> 提前闭合外壳
        packed[key] = s
        print("packed: %-8s %6d chars" % (key, len(html)))

    body = "var PAGES={\n" + ",\n".join('"%s":%s' % (k, v) for k, v in packed.items()) + "\n};\n"
    body += ROUTER_JS % {
        "order": json.dumps(list(PAGES.keys())),
        "fmap": json.dumps({v: k for k, v in PAGES.items()}),
    }

    out = os.path.abspath(args.out)
    with open(out, "w", encoding="utf-8") as f:
        f.write(SHELL_HEAD + body + SHELL_TAIL)
    print("written: %s (%d bytes)" % (out, os.path.getsize(out)))


if __name__ == "__main__":
    main()
