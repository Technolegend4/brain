# -*- coding: utf-8 -*-
"""维护 Aurora_Voyage.html 单文件版：
- 优先读桌面四个原文件；不存在则从现有合并版中提取（自维护，不依赖原文件）
- 注入导航拦截脚本 + 修补首页 JS 跳转（location.href → parent.postMessage）
- 重新生成合并版
"""
import json
import os

DESK = r"C:\Users\ljz15\Desktop"
OUT = os.path.join(DESK, "Aurora_Voyage.html")

PAGES = {
    "home": "aurora-home.html",
    "explore": "aurora-explore.html",
    "connect": "aurora-connect.html",
    "lab": "Blink_Flight_水平间距加大_跳跃平滑版.html",
}

NAV_SCRIPT = """
<script>
(function(){
  var MAP={"aurora-home.html":"home","aurora-explore.html":"explore","aurora-connect.html":"connect","Blink_Flight_\\u6c34\\u5e73\\u95f4\\u8ddd\\u52a0\\u5927_\\u8df3\\u8dc3\\u5e73\\u6ed1\\u7248.html":"lab"};
  document.addEventListener("click",function(e){
    var t=e.target;
    var a=t&&t.closest?t.closest("a[href]"):null;
    if(!a)return;
    var h=a.getAttribute("href");
    if(MAP.hasOwnProperty(h)){e.preventDefault();parent.postMessage({nav:MAP[h]},"*");}
  },true);
})();
</script>
"""

# 首页入口是 JS 跳转（location.href），拦截脚本接不住；改成向外壳发消息
NAV_PATCH = [
    ("window.location.href = h.url;",
     'parent.postMessage({nav: h.url}, "*");'),
]

shell_head = """<!DOCTYPE html>
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

shell_tail = """
</script>
</body>
</html>
"""

FMAP_JS = (
    'var FMAP={"aurora-home.html":"home","aurora-explore.html":"explore",'
    '"aurora-connect.html":"connect",'
    '"Blink_Flight_\\u6c34\\u5e73\\u95f4\\u8ddd\\u52a0\\u5927_\\u8df3\\u8dc3\\u5e73\\u6ed1\\u7248.html":"lab"};\n'
)

ROUTER_JS = """
var ORDER=["home","explore","connect","lab"];
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
}
function route(){
  var k=(location.hash||"#home").slice(1);
  if(ORDER.indexOf(k)<0)k="home";
  show(k);
}
window.addEventListener("hashchange",route);
window.addEventListener("message",function(e){
  var d=e.data||{};
  var nav=d.nav;
  if(nav){
    nav=FMAP[nav]||nav;
    if(ORDER.indexOf(nav)>=0&&location.hash!=="#"+nav)location.hash=nav;
  }
  // 实验室 iframe 无法直连本机 WebSocket（浏览器本地网络限制），由外壳代连并转发
  if(d.wsCmd==="open"){relayOpen(d.url);}
  else if(d.wsCmd==="close"){relayClose();}
});
var wsConn=null,wsLastMsg=0,wsWatch=null;
function labFrame(){return document.getElementById("pg-lab");}
function postLab(o){var f=labFrame();if(f&&f.contentWindow)f.contentWindow.postMessage(o,"*");}
function relayOpen(url){
  try{
    if(wsConn&&wsConn.readyState<=1){try{wsConn.close();}catch(e){}}
    wsLastMsg=0;
    wsConn=new WebSocket(url||"ws://127.0.0.1:7000");
    wsConn.onopen=function(){wsLastMsg=0;postLab({wsState:"open"});};
    wsConn.onerror=function(){postLab({wsState:"error"});};
    wsConn.onclose=function(){postLab({wsState:"close"});};
    wsConn.onmessage=function(ev){wsLastMsg=Date.now();postLab({wsData:ev.data});};
    // 心跳看门狗：曾经收到过数据、现在超过 9 秒没有任何消息 → 连接已半死，主动断开触发重连
    if(wsWatch)clearInterval(wsWatch);
    wsWatch=setInterval(function(){
      if(!wsConn)return;
      if(wsConn.readyState===1&&wsLastMsg&&Date.now()-wsLastMsg>9000){
        try{wsConn.close();}catch(e){}
      }
    },2500);
  }catch(err){postLab({wsState:"error"});}
}
function relayClose(){try{if(wsConn)wsConn.close();}catch(e){}wsConn=null;wsLastMsg=0;if(wsWatch){clearInterval(wsWatch);wsWatch=null;}}
route();
"""


def load_sources():
    """优先原文件；缺失则从现有合并版提取"""
    merged_path = OUT
    pages = {}
    missing = [f for f in PAGES.values() if not os.path.exists(os.path.join(DESK, f))]
    embedded = {}
    if missing:
        print("原文件缺失，从现有合并版提取:", ", ".join(missing))
        with open(merged_path, "r", encoding="utf-8") as f:
            merged = f.read()
        dec = json.JSONDecoder()
        for key in PAGES:
            anchor = '"%s":' % key
            p = merged.find(anchor)
            if p < 0:
                raise SystemExit(f"合并版中找不到 {key}")
            p += len(anchor)
            while merged[p] in " \t":
                p += 1
            html, _ = dec.raw_decode(merged, p)
            # 剥掉上次注入的导航脚本，还原为原始页面
            import re
            nav_re = re.compile(
                r'\n<script>\n\(function\(\)\{\n  var MAP=\{.*?\}\)\(\);\n</script>\n',
                re.S,
            )
            html = nav_re.sub("", html, count=1)
            # 剥掉上次的跳转补丁（如有）
            for old, new in NAV_PATCH:
                html = html.replace(new, old)
            embedded[key] = html
    for key, fname in PAGES.items():
        path = os.path.join(DESK, fname)
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                pages[key] = f.read()
        else:
            pages[key] = embedded[key]
    return pages


def main():
    pages = load_sources()
    pages_js = {}
    for key, html in pages.items():
        # 修补 JS 跳转（在注入导航脚本之前）
        for old, new in NAV_PATCH:
            if old in html:
                html = html.replace(old, new)
                print(f"patched {key}: JS跳转 → postMessage")
        # 注入导航拦截脚本
        if "</body>" in html.lower():
            idx = html.lower().rfind("</body>")
            html = html[:idx] + NAV_SCRIPT + html[idx:]
        else:
            html += NAV_SCRIPT
        s = json.dumps(html, ensure_ascii=False)
        s = s.replace("</", "<\\/")
        pages_js[key] = s
        print("packed:", key, f"({len(html)} chars)")

    js = "var PAGES={\n" + ",\n".join(f'"{k}":{v}' for k, v in pages_js.items()) + "\n};\n" + FMAP_JS + ROUTER_JS

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(shell_head + js + shell_tail)
    print("written:", OUT, f"({os.path.getsize(OUT)} bytes)")


if __name__ == "__main__":
    main()
