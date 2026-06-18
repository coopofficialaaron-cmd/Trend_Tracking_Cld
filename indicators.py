<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>趋势追踪 · Trend Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="styles.css">
</head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="mark"></span>
    <div>
      <h1>趋势追踪</h1>
      <p class="sub">收盘突破 · 吊灯止损 · 头寸规模</p>
    </div>
  </div>
  <div class="market" id="market"></div>
  <div class="meta">
    <span id="updated">—</span>
    <span class="src" id="source"></span>
  </div>
</header>

<nav class="tabs">
  <button class="tab active" data-view="overview">总览</button>
  <button class="tab" data-view="signals">信号<span class="badge" id="sigCount">0</span></button>
  <div class="controls">
    <input id="search" type="search" placeholder="搜索代码 / 名称…" autocomplete="off">
    <select id="typeFilter"><option value="">全部类别</option></select>
  </div>
</nav>

<main>
  <div id="tableWrap" class="table-wrap">
    <table id="grid"><thead></thead><tbody></tbody></table>
  </div>
  <p class="empty" id="empty" hidden></p>
</main>

<!-- Detail drawer -->
<div class="drawer-scrim" id="scrim" hidden></div>
<aside class="drawer" id="drawer" hidden aria-hidden="true">
  <button class="drawer-close" id="drawerClose" aria-label="关闭">×</button>
  <div id="detail"></div>
</aside>

<footer class="foot">
  <span>数据：Stooq（免费，无需密钥）· 仅供研究，非投资建议</span>
  <span>添加股票：编辑仓库根目录的 <code>config.csv</code> 后提交</span>
</footer>

<script src="app.js"></script>
</body>
</html>
