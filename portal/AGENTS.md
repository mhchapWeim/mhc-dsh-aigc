# Portal 开发约定

修改或新增管理页面前，阅读并遵循 [管理页面样式规范](../docs/PORTAL-ADMIN-STYLE.md)。优先复用现有 `data-grid`、`AntPagination`、按钮及弹窗组件；详情长文本必须验证视口约束与正文滚动。

后台视觉遵循 [DESIGN.md](DESIGN.md)，产品与任务边界见 [PRODUCT.md](PRODUCT.md)。公共主题入口是 `app/admin/admin-theme.css`，作用域限定在 `.admin-app`，同步验证浅色、深色及窄屏，保留页面专属表格列宽和弹窗滚动约束。
