# 桔子笔记

一个轻量级桌面笔记应用，基于 React + Tauri + SQLite 构建。

## 技术栈

- **前端**: React 19, TypeScript, Tailwind CSS 4, shadcn/ui
- **桌面运行时**: Tauri 2 (Rust 后端)
- **数据库**: SQLite (rusqlite)
- **状态管理**: Zustand
- **构建工具**: Vite 8

## 功能

- 创建/编辑/删除 Markdown 笔记
- 支持嵌套文件夹（递归树结构）
- VSCode 风格的拖拽排序（行级指示器、hover 展开）
- 深色模式
- 实时搜索（全文 + 文件夹名）
- 图片粘贴（自动存储、懒加载）
- 本地存储（隐私优先）

## 启动

```bash
npm install
npm run tauri:dev
```

## 构建

```bash
npm run tauri:build
```
