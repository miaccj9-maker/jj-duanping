// =====================================================================
// 晋江段评 (jj-duanping) — SillyTavern 扩展
// 模仿晋江文学城「段评」：
//   1. 长按 / 拖选聊天消息里的文本段落
//   2. 松手后出现「✎ 段评」浮动按钮，点击进入段评面板
//   3. 选择评价角色（当前角色或任意其他角色），调取 App 生成评级/段评
//   4. 套用 CSS 模板渲染段评卡片（可管理/新建/导入/导出模板）
//   5. 一键下载段评卡片 PNG 图片
// =====================================================================

/* 绝对路径 import：兼容 system（/scripts/extensions/jj-duanping/）与 third-party
   （/scripts/extensions/third-party/jj-duanping/）两种安装位置——
   相对路径在 third-party（多一层目录）会解析 404，导致模块加载失败、插件整个不运行 */
import {
    addOneMessage,
    chat,
    characters,
    generateQuietPrompt,
    name1,
    saveChatConditional,
    saveSettingsDebounced,
} from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { user_avatar } from '/scripts/personas.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';

// =====================================================================
// 常量
// =====================================================================

const extensionName = 'jj-duanping';
// 自动识别扩展所在目录（public/scripts/extensions 下 或 data 用户扩展 third-party/ 下都能用）
const extensionFolderPath = (() => {
    try {
        const u = new URL('.', import.meta.url);
        return u.pathname.replace(/\/+$/, '');
    } catch {
        return `/scripts/extensions/${extensionName}`;
    }
})();

const DEFAULT_TEMPLATE_ID = 'builtin:晋江段评（默认）';
const DEFAULT_TEMPLATE_NAME = '晋江段评（默认）';
const BUILTIN_KEYS = ['小狗日记小票', 'Ins名片', 'X修复版', 'icity日记', '背景图', '朋友圈', '朋友圈纯文字', '朋友圈夜间', '朋友圈纯文字夜间'];

function compactNewlines(t){return String(t||'').replace(/\r/g,'').replace(/\n{2,}/g,'\n').trim();}
function migrateSettings(settings) {
    if ((settings.promptVersion || 1) < 4) {
        // v4：提示词补充"其他角色"指引——在场角色与「{char}」「{user}」同样存在真实关系，
        // 评价时自然回应但不得编造剧情（用户明确要求修改提示词）
        settings.promptVersion = 4;
        settings.promptTemplate = defaultSettings.promptTemplate;
        // 旧版 cardWidth:460 从未生效，迁移时重置为跟随模板，保持原视觉
        settings.cardWidth = 0;
    }
}

const defaultSettings = {
    activeTemplateId: DEFAULT_TEMPLATE_ID,
    customTemplates: [], // { id, name, css, comments }
    promptVersion: 4,
    promptTemplate: `读取当前剧情片段，以「{char}」本人的身份评价这段剧情。
要求：
- 你（「{char}」）不是在追小说，这段【原文】是你与「{user}」等共同经历过的**真实剧情片段**，你是当事人，不是旁观读者；
- 评价时带入你与「{user}」、以及其他相关角色的关系和处境——可以感同身受、吐槽、心动、嘴硬或毒舌，但必须是你本人会说的话；
- 这段剧情里的其他角色同样与你、「{user}」有着真实的关系（他们也是当事人，不是在追小说）——评价时可以自然回应、提及他们，但不要编造他们没有说过的话或没有发生过的剧情；
- 完全贴合「{char}」的性格、语气、说话习惯和世界观；
- 可以给出评级（星级、分数或一句评价式判词），也可以只写短评，真实、鲜活、口语化；
- 1~3 句即可，禁止 AI 腔、禁止 AI 八股套话（不要"真是命运/好感动/被治愈了/这就是爱吧/一切都是最好的安排"这类空话套话），禁止解释，禁止出现"作为读者/作为AI"这类话；要像本人平时发朋友圈/发碎碎念那样说人话，可以很短、可以只蹦一两个字、可以毒舌/沉默/嘴硬/阴阳怪气；
- 直接输出段评正文，不要任何前缀或注释。
{extra_block}
【原文】
{quote}`,
    bookTitle: '',
    chapterText: '',
    watermarkText: '',
    quoteSize: 15,
    quoteLh: 1.6,
    quoteLs: 0, // 字距（em），0 = 模板默认
    cardWidth: 0, // 0/空 = 跟随模板自带宽度；>0 = 强制图片宽度(px)
    // 自填 API（可选；开启后生成走这里，否则走酒馆已连接的 App）
    apiEnabled: false,
    apiUrl: '',
    apiKey: '',
    apiModel: '',
    // 角色 @ID：手动覆盖表（角色名 -> ID 字符串，不带@）
    charIdMap: {},
    userId: '',
    captureEngine: 'auto', // auto | html2canvas | svg
    html2canvasUrl: 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
    showLauncher: true, // 右下角常驻「✎ 段评」入口
    nightMode: false, // 夜间模式（对所有模板生效，保证暗色下文字清晰可见）
    stickers: [], // 当前卡片贴纸：{id,type:'emoji'|'kaomoji'|'img',content,x,y,size|width,rot}
    stickerImages: [], // 用户上传的图片贴纸（dataURL 列表，localStorage 持久化）
    // 背景图模板：URL 或本地上传 base64（应用到当前卡片背景）
    bgImage: '',
    // 自定义字体链接（woff2/ttf/otf），卡片全部文本替换为该字体
    fontUrl: '',
    // 文本位移（px）：预览区拖动正文调整，下载同步
    textOffsetX: 0,
    textOffsetY: 0,
    // 背景图模板：文字颜色 / 字号 / 行距（仅「背景图」模板生效）
    textColor: '#ffffff',
    bgQuoteSize: 22,
    bgQuoteLh: 1.8,
    // 字体库：解析 @import CSS 后得到的 ttf/woff2 直链
    fontLib: [],
    // 已应用字体的 base64 内联（跨域兜底，保证预览/下载真正换字体）
    fontB64: '',
    // 打孔拼贴诗（背景图模板专用）：逐字/逐词纸片拼贴到背景图上
    // 词条: {id,text,x,y,w,h,rot,shape:'rect'|'round'|'circle'|'ellipse',bg,fg,size}（x/y/w/h 为背景图自然像素坐标系）
    collageEnabled: false,
    collageWords: [],
    collageBgColor: '#000000', // 无背景图时编辑画布/卡片的底色
    collageImgW: 0, // 背景图自然宽（加载后缓存，供 1:1 输出）
    collageImgH: 0,
};

// 内置字体库（fontsapi.zeoseven.com 分片 CSS，首次进入自动注入字体库，可点选应用，不显示删除）
const BUILTIN_FONTS = [
    { name: '霞鹜文楷', url: extensionFolderPath + '/fonts/LXGWWenKai-Regular.ttf', builtin: true },
    { name: '落霞新熹黑', url: extensionFolderPath + '/fonts/LXGWNeoXiHei.ttf', builtin: true },
    { name: '落霞新致宋', url: extensionFolderPath + '/fonts/LXGWNeoZhiSong.ttf', builtin: true },
    { name: 'PING FANG SHAGN SHANG QIAN', url: 'https://fontsapi.zeoseven.com/511/main/result.css', builtin: true },
    { name: 'KingHwaOldSong', url: 'https://fontsapi.zeoseven.com/309/main/result.css', builtin: true },
    { name: 'TaiwanPearl', url: 'https://fontsapi.zeoseven.com/710/main/result.css', builtin: true },
];

// 默认模板：晋江段评风格（内置，不落盘）
const EMERGENCY_CSS = `
/* ===== 应急兜底（模板文件缺失时） ===== */
.be-card.be-custom {
  box-sizing: border-box;
  background: #fff;
  color: #333;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  padding: 16px 18px;
  border-radius: 10px;
}
.be-card.be-custom .be-quote { white-space: pre-wrap; overflow-wrap: break-word; }
`;
// 注入在模板 CSS 之后的基础保底样式（保证段评内容在所有模板下可见）
const CARD_BASE_CSS = `
html, body { margin: 0; padding: 0; background: transparent; }
body { padding: 1px; }
.be-card.be-custom { box-sizing: border-box; max-width: 100% !important; }
.be-card.be-custom .be-quote,
.be-card.be-custom .be-thought-main {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  word-break: break-word;
}
/* 正文排版强制跟随界面设置（字号/行高/字距），覆盖模板写死的固定值，
   否则行距会跟随模板/环境默认而不可控 */
.be-card.be-custom .be-quote {
  font-size: var(--be-quote-size, 15px) !important;
  line-height: var(--be-quote-lh, 1.6) !important;
  letter-spacing: var(--be-quote-ls, 0em) !important;
}
/* 小狗日记小票标题：真实 span 替代伪元素（复刻模板 ::before/::after 视觉，
   保证 html2canvas 下载也能渲染出“小狗日记 / 欢迎光临sillytavern”） */
.be-card.be-custom .be-watermark .be-wm-title {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  font-size: 32px;
  font-weight: 900;
  letter-spacing: 5px;
  text-indent: 5px;
  color: #000;
  line-height: 33px;
  white-space: nowrap;
  -webkit-text-stroke: 1px #000;
  text-shadow: 1px 0 0 #000, -1px 0 0 #000, 0 1px 0 #000, 0 -1px 0 #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
  font-family: "Nightgazer 16", "SimHei", "NSimSun", "SimSun", monospace;
}
.be-card.be-custom .be-watermark .be-wm-sub {
  position: absolute;
  top: 35px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 2px;
  text-indent: 2px;
  color: var(--be-card-fg, #000);
  line-height: 14px;
  white-space: nowrap;
  font-family: "Nightgazer 16", "Fixedsys", "NSimSun", "SimSun", "Courier New", monospace;
}
.be-card.be-custom .be-thought-main { display: block !important; }
/* wrap 不设 max-width：宽度完全由 fitFrame 控制（否则与 iframe 宽度循环依赖，导致调宽无效） */
.dp-card-wrap { width: max-content; }
.be-comments { width: 100%; box-sizing: border-box; }
.be-comment-avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  background: linear-gradient(135deg, #a9b8c9, #7f92a5);
}
/* 评论操作：回评/点赞（右下角极简矢量图标） */
.be-comment-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 14px;
  margin-top: 5px;
}
.be-comment-actions .be-act {
  display: inline-flex;
  align-items: center;
  color: #b3b3b3;
  line-height: 1;
}
.be-comment-actions .be-act svg { display: block; }
/* 贴纸：可拖拽到卡片任意位置（微信式），随卡片缩放/下载保持一致 */
.dp-card-wrap { position: relative; }
.dp-sticker {
  position: absolute;
  z-index: 60;
  line-height: 1;
  user-select: none;
  -webkit-user-select: none;
  cursor: move;
  touch-action: none;
}
.dp-sticker span {
  display: block;
  white-space: nowrap;
  line-height: 1.2;
}
.dp-sticker-img img {
  display: block;
  width: 100%;
  pointer-events: none;
  user-select: none;
  -webkit-user-select: none;
}
.dp-sticker-drag { opacity: 0.85; }
/* 打孔拼贴诗：纸片词条（1:1 背景图上逐字/逐词拼贴） */
.dp-collage-card {
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
}
.dp-collage-word {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  white-space: nowrap;
  line-height: 1.15;
  overflow: hidden;
  z-index: 60;
  user-select: none;
  -webkit-user-select: none;
  pointer-events: auto; /* 拼贴直操作：在预览上可点选/拖动 */
  cursor: move;
  touch-action: none;
}
.dp-collage-word .dp-collage-resize {
  position: absolute;
  right: -8px;
  bottom: -8px;
  width: 16px;
  height: 16px;
  background: #ff5c7a;
  border: 2px solid #fff;
  border-radius: 50%;
  cursor: nwse-resize;
  display: none;
  z-index: 70;
  box-shadow: 0 1px 4px rgba(0,0,0,.25);
}
.dp-collage-word.sel .dp-collage-resize {
  display: block;
}
.dp-collage-word span {
  display: block;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
}
/* 仿真实纸张材质（叠加在纸色上，轻量渐变/纹理，无外部图片） */
.dp-collage-word.dp-paper-none {
  background-color: transparent !important;
  background-image: none !important;
  box-shadow: none !important;
}
.dp-collage-word.dp-paper-kraft {
  background-image: repeating-linear-gradient(0deg, rgba(120,90,50,.12) 0 1px, transparent 1px 4px), linear-gradient(160deg, rgba(190,150,90,.4), rgba(160,120,70,.18) 50%, rgba(130,95,55,.34));
  box-shadow: 0 2px 5px rgba(90,60,20,.3), inset 0 0 0 1px rgba(122,82,30,.25);
}
.dp-collage-word.dp-paper-craft {
  background-image: repeating-linear-gradient(90deg, rgba(120,80,40,.12) 0 2px, transparent 2px 7px), linear-gradient(160deg, rgba(165,110,55,.44), rgba(125,80,38,.22) 55%, rgba(100,62,28,.38));
  box-shadow: 0 3px 6px rgba(80,50,18,.32), inset 0 0 0 1px rgba(120,80,38,.32);
}
.dp-collage-word.dp-paper-xuan {
  background-image: radial-gradient(rgba(160,130,90,.32) .8px, transparent 1.2px);
  background-size: 6px 6px;
  box-shadow: 0 1px 3px rgba(0,0,0,.14), inset 0 0 0 1px rgba(140,110,70,.16);
}
.dp-collage-word.dp-paper-news {
  background-image: repeating-linear-gradient(0deg, rgba(80,80,80,.18) 0 1px, transparent 1px 10px);
  box-shadow: 0 1px 3px rgba(0,0,0,.16);
}
.dp-collage-word.dp-paper-lined {
  background-image: repeating-linear-gradient(0deg, rgba(90,140,220,.4) 0 1px, transparent 1px 13px);
  box-shadow: 0 1px 3px rgba(0,0,0,.12), inset 0 0 0 1px rgba(0,0,0,.05);
}
.dp-collage-word.dp-paper-grid {
  background-image: repeating-linear-gradient(0deg, rgba(90,140,220,.34) 0 1px, transparent 1px 15px), repeating-linear-gradient(90deg, rgba(90,140,220,.34) 0 1px, transparent 1px 15px);
  box-shadow: 0 1px 3px rgba(0,0,0,.12);
}
.dp-collage-word.dp-paper-torn {
  box-shadow: 0 3px 8px rgba(0,0,0,.3), inset 0 0 0 1px rgba(0,0,0,.08);
}
`;

// 夜间模式通用覆盖（在模板 CSS 之后注入，!important 保证各模板统一生效）
// 模板若自带夜间样式，可在模板 JSON 中加 "night" 字段，渲染时追加在通用覆盖之后
const NIGHT_CSS = `
/* ===== 夜间模式（通用覆盖，深黑背景 + 纯白文字 + 白色条形码） ===== */
/* 直接覆盖模板 CSS 变量：所有用 var(--be-card-fg) 等变量的文本自动转亮色 */
.be-card.be-custom {
  --be-card-fg: #ffffff !important;
  --be-card-bg: #000000 !important;
  --be-card-sub: #b8b8c0 !important;
  background: #000000 !important;
  color: #ffffff !important;
  border-color: rgba(255, 255, 255, 0.16) !important;
  box-shadow: 0 6px 28px rgba(0, 0, 0, 0.55) !important;
}
/* 小票“小狗日记”标题（模板用 transparent 隐藏文字，夜间恢复为亮色显示） */
.dp-card-wrap .be-card.be-custom .be-watermark { color: #ffffff !important; background: #1a1a1a !important; border-bottom-color: #333 !important; }
/* 标题本体在 ::before 里且模板写死三重黑（color/stroke/shadow），夜间全部转亮 */
/* 注意：html2canvas 1.4.1 对「白字 + -webkit-text-stroke 1px 深色」存在渲染 bug（文字整块消失），
   夜间必须把描边归零，纯白字才能稳定画出 */
.dp-card-wrap .be-card.be-custom .be-watermark::before {
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
  -webkit-text-stroke: 0 !important;
  -webkit-text-stroke-width: 0 !important;
  text-shadow: none !important;
}
.dp-card-wrap .be-card.be-custom .be-watermark::after { color: #ffffff !important; }
/* 真实 span 版标题（html2canvas 可靠渲染）：夜间转白（提级双保险，覆盖任何来源的黑字规则） */
html .dp-card-wrap .be-card.be-custom .be-watermark .be-wm-title,
.dp-card-wrap .be-card.be-custom .be-watermark .be-wm-title {
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
  -webkit-text-stroke: 0 !important;
  -webkit-text-stroke-width: 0 !important;
  text-shadow: none !important;
  filter: none !important;
  opacity: 1 !important;
}
html .dp-card-wrap .be-card.be-custom .be-watermark .be-wm-sub,
.dp-card-wrap .be-card.be-custom .be-watermark .be-wm-sub {
  color: #d8d8de !important;
  -webkit-text-fill-color: #d8d8de !important;
  -webkit-text-stroke: 0 !important;
  text-shadow: none !important;
  opacity: 1 !important;
}
.be-card.be-custom .be-quote,
.be-card.be-custom .be-thought-main,
.be-card.be-custom .be-text,
.be-card.be-custom .be-content { color: #ffffff !important; }
.be-card.be-custom .be-author,
.be-card.be-custom .be-name,
.be-card.be-custom .be-source,
.be-card.be-custom .be-handle,
.be-card.be-custom .be-nick { color: #e6e6ec !important; }
.be-card.be-custom .be-date,
.be-card.be-custom .be-date-cn,
.be-card.be-custom .be-meta,
.be-card.be-custom .be-time { color: #ffffff !important; }
.be-card.be-custom .be-quote-orig { color: #d6d6de !important; border-left-color: rgba(255, 255, 255, 0.35) !important; }
.be-card.be-custom .be-mask-block { background: currentColor !important; }
.be-card.be-custom .be-hairline,
.be-card.be-custom .be-divider { border-color: rgba(255, 255, 255, 0.14) !important; }
.be-card.be-custom .be-tag { color: #d6d6de !important; border-color: rgba(255, 255, 255, 0.25) !important; }
/* 评论模块：统一用 .dp-card-wrap 前缀（commentsInside=false 的模板评论渲染在卡片外，挂 .be-card 前缀会漏掉） */
.dp-card-wrap .be-comments {
  background: #000000 !important;
  border-color: rgba(255, 255, 255, 0.14) !important;
  color: #ffffff !important;
}
.dp-card-wrap .be-comment { border-color: rgba(255, 255, 255, 0.1) !important; background: transparent !important; }
.dp-card-wrap .be-comment-name { color: #ffffff !important; }
.dp-card-wrap .be-comment[data-kind="user"] .be-comment-name { color: #f0a87e !important; }
.dp-card-wrap .be-comment-id,
.dp-card-wrap .be-comment-time,
.dp-card-wrap .be-comment-meta { color: #b8b8c0 !important; }
.dp-card-wrap .be-comment-text { color: #f2f2f6 !important; }
.dp-card-wrap .be-comment-avatar { filter: brightness(0.9); }
.dp-card-wrap .be-comment-avatar-fallback { background: linear-gradient(135deg, #3a4250, #2b3340) !important; }
.dp-card-wrap .be-comment-actions .be-act { color: #8e8e9a !important; }
`;

// =====================================================================
// 贴纸库：emoji / 颜文字 / 内置图片贴纸（SVG dataURL，离线可用）
// =====================================================================

const EMOJI_STICKERS = ['😊', '😂', '😍', '😭', '😡', '🥺', '😳', '🤔', '😴', '🥳', '✨', '💖', '💔', '🔥', '👀', '👍', '🫶', '🌸', '🍑', '💀'];

const KAOMOJI_STICKERS = [
    '(◕‿◕✿)', '(╯°□°)╯︵┻━┻', '(´･_･`)', '(≧∇≦)ﾉ', '(￣▽￣)~*',
    '(๑•̀ㅂ•́)و✧', '(╥﹏╥)', '(✿◠‿◠)', '(°▽°)', '¯\\_(ツ)_/¯',
];

const STICKER_IMG_KEY = 'jj_duanping_sticker_images';

function stickerImageLib() {
    try {
        const raw = localStorage.getItem(STICKER_IMG_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveStickerImageLib(list) {
    try {
        localStorage.setItem(STICKER_IMG_KEY, JSON.stringify(list.slice(0, 24)));
    } catch (err) {
        console.warn('[晋江段评] 贴纸图片保存失败', err);
        toast('error', '图片贴纸保存失败（存储空间不足？）');
    }
}

/** 上传的贴纸大图自动压缩：最长边 512px，保留透明 PNG；过大时转 JPEG 降体积 */
function compressStickerImage(dataUrl, cb) {
    const img = new Image();
    img.onload = () => {
        try {
            const MAX = 512;
            const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * ratio));
            const h = Math.max(1, Math.round(img.height * ratio));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);
            let out = canvas.toDataURL('image/png');
            if (out.length > 500 * 1024) out = canvas.toDataURL('image/jpeg', 0.85);
            cb(out);
        } catch (err) {
            cb(dataUrl);
        }
    };
    img.onerror = () => cb(dataUrl);
    img.src = dataUrl;
}

/** 把贴纸渲染为卡片内 HTML（绝对定位在 .dp-card-wrap 内容坐标系） */
function buildStickersHtml(stickers) {
    if (!stickers || !stickers.length) return '';
    return stickers.map((s) => {
        const rot = s.rot || 0;
        if (s.type === 'img') {
            return `<div class="dp-sticker dp-sticker-img" data-sid="${esc(s.id)}" style="left:${Number(s.x) || 0}px;top:${Number(s.y) || 0}px;width:${s.width || 90}px;transform:rotate(${rot}deg);"><img src="${esc(s.content)}" draggable="false"></div>`;
        }
        const fs = s.size || 40;
        return `<div class="dp-sticker" data-sid="${esc(s.id)}" style="left:${Number(s.x) || 0}px;top:${Number(s.y) || 0}px;font-size:${fs}px;transform:rotate(${rot}deg);"><span>${esc(s.content)}</span></div>`;
    }).join('');
}



/** 模板 id -> 平台 key（用于评论样式/时间格式） */
function getTemplateKey(id) {
    if (!id) id = getSettings().activeTemplateId || DEFAULT_TEMPLATE_ID;
    if (typeof id === 'string' && id.startsWith('builtin:')) return id.slice('builtin:'.length);
    return '__custom__';
}

/** 按平台生成评论时间文本 */
function commentTimeText(key, index) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const full = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (key === 'X修复版') return index === 0 ? '刚刚' : `${index}分钟前`;
    if (key === 'Ins名片') return `${p(d.getMonth() + 1)}月${p(d.getDate())}日`;
    if (key === 'icity日记') return `${md} ${p(d.getHours())}:${p(d.getMinutes())}`;
    if (key === '小狗日记小票') return full;
    return full;
}

// 运行时状态（不持久化）
const dp = {
    selection: null, // { text, mesIndex, author }
    lastFilled: null, // 上次已填入输入框的选区标识（用于识别“新选区”）
    raterCharIds: [-1], // 可多选；-1 = 当前角色
    comments: [], // { id, kind: 'char'|'user', authorName, authorHandle, avatarUrl, timeText, text }
    busy: false,
    ctxMenuOpen: false,
};

// =====================================================================
// 工具函数
// =====================================================================

function deepClone(obj) {
    try {
        return structuredClone(obj);
    } catch {
        return JSON.parse(JSON.stringify(obj));
    }
}

/** 字体输入自动解析：@import CSS → 提取家族名并入库 CSS 链接；字体直链 → 入库直链。返回 {family,url} 或 null */
async function parseFontCssAuto(raw) {
    raw = String(raw || '').trim();
    if (!raw) return null;
    const st = getSettings();
    const lib = st.fontLib || (st.fontLib = []);
    const seenNames = new Set();
    st.fontLib = lib.filter((x) => (seenNames.has(x.name) ? false : (seenNames.add(x.name), true)));
    const lib2 = st.fontLib;
    if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(raw)) {
        const name = 'font_' + (lib2.length + 1);
        lib2.push({ name, url: raw });
        saveSettingsDebounced();
        renderFontLib();
        return { family: name, url: raw };
    }
    const m = raw.match(/@import\s+url\(["']?([^"')]+)["']?\)/) || (raw.indexOf('http') === 0 ? [raw, raw] : null);
    const cssUrl = m ? m[1] : null;
    if (!cssUrl) return null;
    const resp = await fetch(cssUrl);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const cssText = await resp.text();
    const faces = cssText.match(/@font-face\s*\{([^}]+)\}/g) || [];
    if (!faces.length) return null;
    const fm0 = faces[0].match(/font-family\s*:\s*["']?([^"';]+)/);
    const family0 = fm0 ? fm0[1].trim().replace(/^["']|["']$/g, '') : '';
    const name = family0 || ('font_' + (lib2.length + 1));
    if (!seenNames.has(name)) {
        seenNames.add(name);
        lib2.push({ name, url: cssUrl });
    } else {
        const idx = lib2.findIndex((x) => x.name === name);
        if (idx >= 0 && /\.(woff2?|ttf|otf)(\?|#|$)/i.test(lib2[idx].url) && !/\.(woff2?|ttf|otf)(\?|#|$)/i.test(cssUrl)) {
            lib2[idx] = { name, url: cssUrl };
        }
    }
    saveSettingsDebounced();
    renderFontLib();
    return { family: name, url: cssUrl };
}
/** 字体链接解析：@import CSS → 提取 @font-face 的 ttf/woff2 直链入库 */
async function parseFontLink() {
    const inp = document.getElementById('dp-set-fonturl');
    if (!inp) return;
    const raw = (inp.value || '').trim();
    if (!raw) { toast('warning', '请先粘贴字体链接'); return; }
    const st = getSettings();
    const lib = st.fontLib || (st.fontLib = []);
    // 同名去重：fontsapi 的 css 常含几十个同名 @font-face，只保留一个避免重复入库
    const seenNames = new Set();
    st.fontLib = lib.filter((x) => (seenNames.has(x.name) ? false : (seenNames.add(x.name), true)));
    const lib2 = st.fontLib;
    // 1) 直接字体文件链接（.ttf/.woff2/.otf）
    if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(raw)) {
        const name = 'font_' + (lib2.length + 1);
        lib2.push({ name, url: raw });
        saveSettingsDebounced();
        toast('success', '字体已入库：' + name);
        renderFontLib();
        return;
    }
    // 2) @import url(...) 或裸 css 链接
    const m = raw.match(/@import\s+url\(["']?([^"')]+)["']?\)/) || (raw.indexOf('http') === 0 ? [raw, raw] : null);
    const cssUrl = m ? m[1] : null;
    if (!cssUrl) { toast('warning', '无法识别的字体链接'); return; }
    try {
        const resp = await fetch(cssUrl);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const cssText = await resp.text();
        const faces = cssText.match(/@font-face\s*\{([^}]+)\}/g) || [];
        if (!faces.length) { toast('warning', '未解析到可用字体（可能跨域）'); return; }
        let added = 0;
        // 分片 CSS（cn-font-split：同 family 多个 @font-face）统一入库 CSS 链接本身，
        // 应用时原样注入全部 @font-face（浏览器按需加载分片）——不再逐分片入库去重（否则只剩第一个分片 → 只生效几个字）
        const fm0 = faces[0].match(/font-family\s*:\s*["']?([^"';]+)/);
        const family0 = fm0 ? fm0[1].trim().replace(/^["']|["']$/g, '') : '';
        const name = family0 || ('font_' + (lib.length + 1));
        if (!seenNames.has(name)) {
            seenNames.add(name);
            lib2.push({ name, url: cssUrl });
            added++;
        } else {
            // 同名已存在：若旧条目是分片 woff2 直链而新条目是 CSS 链接 → 替换（CSS 才是完整字体源，否则点旧条目只生效几个字）
            const idx = lib2.findIndex((x) => x.name === name);
            if (idx >= 0 && /\.(woff2?|ttf|otf)(\?|#|$)/i.test(lib2[idx].url) && !/\.(woff2?|ttf|otf)(\?|#|$)/i.test(cssUrl)) {
                lib2[idx] = { name, url: cssUrl };
                added++;
            }
        }
        saveSettingsDebounced();
        toast(added ? 'success' : 'warning', added ? '解析成功，入库 ' + added + ' 个字体' : '未解析到可用字体（可能跨域）');
        renderFontLib();
    } catch (e) {
        toast('warning', '字体解析失败：' + (e.message || '网络/跨域问题'));
    }
}

/** 字体库渲染：点击名称应用为当前字体，点 × 删除 */
function renderFontLib() {
    const box = document.getElementById('dp-font-lib');
    if (!box) return;
    const st = getSettings();
    const lib = st.fontLib || [];
    for (const bf of BUILTIN_FONTS) if (!lib.some((x) => x.url === bf.url)) lib.push(bf);
    // 同名去重：CSS 链接条目（分片整体）一律优先，之后才轮不到非 CSS 条目——
    // 否则旧版逐分片入库残留的第一个分片 woff2 会被保留 → 点击只生效那几个字
    const cssItems = lib.filter((it) => !/\.(woff2?|ttf|otf)(\?|#|$)/i.test(it.url) && !/^data:/i.test(it.url));
    const otherItems = lib.filter((it) => /\.(woff2?|ttf|otf)(\?|#|$)/i.test(it.url) || /^data:/i.test(it.url));
    const seen = new Map();
    for (const it of [...cssItems, ...otherItems]) {
        if (!seen.has(it.name)) seen.set(it.name, it);
    }
    const uniq = [...seen.values()];
    if (uniq.length !== lib.length) { st.fontLib = uniq; saveSettingsDebounced(); }
    box.innerHTML = '';
    if (!uniq.length) { box.textContent = '（暂无字体，粘贴 @import 链接后点「解析入库」）'; return; }
    for (const it of uniq) {
        const chip = document.createElement('span');
        chip.className = 'dp-font-chip' + (st.fontUrl === it.url ? ' dp-font-chip-on' : '');
        chip.textContent = it.name;
        chip.title = it.url;
        chip.addEventListener('click', async () => {
            st.fontUrl = it.url;
            st.fontB64 = '';
            // 切换字体必须清掉旧的 IndexedDB 分片缓存与旧家族名，否则 loadFontCssText 仍返回旧字体 → 切字体无效
            st.fontCssKey = '';
            st.fontFamily = it.name || 'dp-font-custom';
            saveSettingsDebounced();
            const inp = document.getElementById('dp-set-fonturl');
            if (inp) inp.value = it.url;
            // 跨域兜底：字体文件直链转 base64；CSS 分片走 ensureFontB64 原样注入（不得把 CSS 文本当字体 base64）
            if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(it.url) || /^data:/i.test(it.url)) {
                try {
                    const resp = await fetch(it.url);
                    if (resp.ok) {
                        const blob = await resp.blob();
                        st.fontB64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result)); rd.readAsDataURL(blob); });
                        saveSettingsDebounced();
                        if (inp) inp.value = '已应用：' + it.name;
                    }
                } catch (e) { /* 跨域失败保留原链接 */ }
            } else {
                await ensureFontB64(st);
                if (inp) inp.value = '已应用：' + (st.fontFamily || it.name);
            }
            renderFontLib();
            renderCard();
        });
        const del = document.createElement('span');
        del.className = 'dp-font-del';
        del.textContent = '×';
        del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            st.fontLib = uniq.filter((x) => x.url !== it.url);
            if (st.fontUrl === it.url) { st.fontUrl = ''; st.fontB64 = ''; }
            saveSettingsDebounced();
            renderFontLib();
            renderCard();
        });
        if (!it.builtin) chip.appendChild(del);
        box.appendChild(chip);
    }
}

/** 字体链接 → base64 内联（幂等）：保证跨域字体也能加载，预览/下载一致 */
/** IndexedDB：字体分片 base64 较大，localStorage 放不下 */
function idbOpen() {
    return new Promise((res, rej) => {
        const rq = indexedDB.open('jj-duanping', 1);
        rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
    });
}
async function idbGet(k) {
    try { const db = await idbOpen(); return await new Promise((res) => { const rq = db.transaction('kv').objectStore('kv').get(k); rq.onsuccess = () => res(rq.result); rq.onerror = () => res(null); }); }
    catch (e) { return null; }
}
async function idbSet(k, v) {
    try { const db = await idbOpen(); return await new Promise((res) => { const rq = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); rq.onsuccess = () => res(true); rq.onerror = () => res(false); }); }
    catch (e) { return false; }
}
function blobToDataURL(blob) {
    return new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result)); rd.readAsDataURL(blob); });
}

async function ensureFontB64(settings, quiet) {
    if (!settings) settings = getSettings();
    if (!settings.fontUrl) return;
    if (settings.fontCssKey && settings._fontCssUrl === settings.fontUrl) return; // 分片 CSS 已注入（URL 未变）
    if (settings.fontB64 && settings._fontB64Url === settings.fontUrl) return;    // 单字体 base64 已生成（URL 未变）
    if (settings._fontFetching) return;
    settings._fontFetching = true;
    const raw = String(settings.fontUrl).trim();
    try {
        if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(raw) || /^data:/i.test(raw)) {
            // 单字体直链：下载转 base64（单个字体体积可控）
            const resp2 = await fetch(raw);
            if (!resp2.ok) throw new Error('HTTP ' + resp2.status);
            const blob = await resp2.blob();
            settings.fontB64 = await blobToDataURL(blob);
            settings._fontB64Url = raw;
            settings._fontCssUrl = '';
            settings.fontFamily = settings.fontFamily || 'dp-font-custom';
            settings.fontUrl = raw;
            saveSettingsDebounced();
            settings._fontFetching = false;
            return;
        }
        // CSS 链接 / @import 代码块：解析全部 @font-face（字符子集），保留原始 URL（相对路径转绝对）原样注入，
        const m = raw.match(/@import\s+url\(["']?([^"')]+)["']?\)/) || (/^https?:\/\//i.test(raw) ? [raw, raw] : null);
        const cssUrl = m ? m[1] : null;
        if (!cssUrl) { if (!quiet) toast('warning', '无法识别的字体链接'); settings._fontFetching = false; return; }
        const resp = await fetch(cssUrl);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const cssText = await resp.text();
        const faces = cssText.match(/@font-face\s*\{([^}]+)\}/g) || [];
        if (!faces.length) throw new Error('css 中没有 @font-face');
        let family = '';
        const rebuilt = [];
        for (const face of faces) {
            const fm = face.match(/font-family\s*:\s*["']?([^"';]+)/);
            if (fm && !family) family = fm[1].trim().replace(/^["']|["']$/g, '');
            // 相对 url → 绝对 url；保留 unicode-range，浏览器按需加载分片（无需全部下载转 base64）
            rebuilt.push(face.replace(/local\([^)]*\)\s*,?\s*/gi, '').replace(/url\(["']?([^"')]+)["']?\)/g, (all, u) => 'url("' + new URL(u, cssUrl).href + '")'));
        }
        if (!rebuilt.length) throw new Error('字体分片解析失败');
        // 收集全部分片 URL，渲染前主动 fetch 进浏览器缓存（响应头 immutable，命中缓存即不再依赖 iframe 按需加载）
        settings._fontShards = [];
        for (const rf of rebuilt) {
            const um = rf.match(/url\(["']?([^"')]+)["']?\)/);
            if (um) settings._fontShards.push(um[1]);
        }
        const key = 'jjdp_font_' + Date.now();
        await idbSet(key, rebuilt.join('\n'));
        settings.fontCssKey = key;
        settings.fontB64 = '';              // 清旧单字体 base64（否则 loadFontCssText 优先用旧字体 → 新字体不生效）
        settings._fontCssUrl = cssUrl;
        settings._fontB64Url = '';
        settings.fontFamily = family || 'dp-font-custom';
        settings.fontUrl = cssUrl;
        saveSettingsDebounced();
        toast('success', '字体已就绪：' + faces.length + ' 个分片（按需加载）');
    } catch (e) {
        // 跨域兜底：fetch 分片失败时改用浏览器原生 @import 加载（不依赖 fetch CORS），下次刷新同样生效
        const urlL = settings.fontUrl;
        if (urlL && /^https?:/i.test(urlL)) {
            settings.fontCssKey = 'link:' + urlL;
            settings.fontUrl = urlL;
            settings.fontB64 = '';
            settings._fontCssUrl = urlL;
            settings._fontB64Url = '';
            saveSettingsDebounced();
            if (!quiet) toast('success', '字体已切换（源站链接加载，首次需联网）');
        } else if (!quiet) {
            toast('warning', '字体加载失败：' + (e.message || '跨域/网络'));
        }
    }
    settings._fontFetching = false;
}

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = deepClone(defaultSettings);
    }
    // 补齐新增字段（升级兼容）
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][k] === undefined) {
            extension_settings[extensionName][k] = deepClone(v);
        }
    }
    migrateSettings(extension_settings[extensionName]);
    return extension_settings[extensionName];
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function toast(type, msg) {
    try {
        if (typeof toastr !== 'undefined' && toastr[type]) {
            toastr[type](msg, '晋江段评');
            return;
        }
    } catch { /* ignore */ }
    alert(`[晋江段评] ${msg}`);
}

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function dateStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dateCn() {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

// =====================================================================
// 模板系统
// =====================================================================

// 模板 JSON 缓存：内置模板文件较大（如小狗日记小票含内嵌图 base64，~900KB），
// 每次 renderCard 都 fetch+JSON.parse 会明显卡顿，这里按 key 缓存解析结果，
// 仅在模板管理操作（导入/删除/建副本/编辑保存）后失效。
const templateCache = new Map();

async function fetchBuiltinTemplateJson(key) {
    const hit = templateCache.get(key);
    if (hit) return hit;
    const resp = await fetch(`${extensionFolderPath}/templates/${encodeURIComponent(key)}.json`);
    if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
    }
    const json = await resp.json();
    templateCache.set(key, json);
    return json;
}

function invalidateTemplateCache() {
    templateCache.clear();
}

/** 解析模板 id -> 正文 css 文本（从模板文件读取） */
async function resolveTemplateCss(id) {
    const settings = getSettings();
    if (!id) {
        id = settings.activeTemplateId || DEFAULT_TEMPLATE_ID;
    }
    if (id.startsWith('builtin:')) {
        const key = id.slice('builtin:'.length);
        try {
            const json = await fetchBuiltinTemplateJson(key);
            return json.css || '';
        } catch {
            return EMERGENCY_CSS;
        }
    }
    const custom = (settings.customTemplates || []).find((t) => t.id === id);
    return custom ? custom.css : EMERGENCY_CSS;
}

/** 解析模板 id -> 评论模块 css（模板 JSON 的 comments 字段；无则读兜底文件） */
async function resolveTemplateComments(id) {
    const settings = getSettings();
    if (!id) {
        id = settings.activeTemplateId || DEFAULT_TEMPLATE_ID;
    }
    let comments = '';
    try {
        if (id.startsWith('builtin:')) {
            const key = id.slice('builtin:'.length);
            const json = await fetchBuiltinTemplateJson(key);
            comments = json.comments || '';
        } else {
            const custom = (settings.customTemplates || []).find((t) => t.id === id);
            comments = (custom && custom.comments) || '';
        }
    } catch {
        /* 走兜底 */
    }
    if (comments && comments.trim()) {
        return comments;
    }
    try {
        const resp = await fetch(`${extensionFolderPath}/templates/${encodeURIComponent('_兜底评论.json')}`);
        if (resp.ok) {
            const json = await resp.json();
            if (json.comments && json.comments.trim()) {
                return json.comments;
            }
        }
    } catch {
        /* 无兜底文件，返回空串 */
    }
    return '';
}

/** 评论是否渲染进卡片内部（模板 JSON 的 commentsInside 字段；晋江/Ins 为 true 实现真正一体） */
async function resolveTemplateCommentsInside(id) {
    const settings = getSettings();
    if (!id) {
        id = settings.activeTemplateId || DEFAULT_TEMPLATE_ID;
    }
    try {
        if (id.startsWith('builtin:')) {
            const key = id.slice('builtin:'.length);
            const json = await fetchBuiltinTemplateJson(key);
            return json.commentsInside === true;
        }
        const custom = (settings.customTemplates || []).find((t) => t.id === id);
        return !!(custom && custom.commentsInside === true);
    } catch {
        return false;
    }
}

/** 模板自带的夜间样式（模板 JSON 的 night 字段，可选；追加在通用夜间覆盖之后） */
async function resolveTemplateNight(id) {
    const settings = getSettings();
    if (!id) {
        id = settings.activeTemplateId || DEFAULT_TEMPLATE_ID;
    }
    try {
        if (id.startsWith('builtin:')) {
            const key = id.slice('builtin:'.length);
            const json = await fetchBuiltinTemplateJson(key);
            return json.night || '';
        }
        const custom = (settings.customTemplates || []).find((t) => t.id === id);
        return (custom && custom.night) || '';
    } catch {
        return '';
    }
}

/** 评论操作图标：回评（回复箭头） + 点赞（心形），极简线条风 */
const REPLY_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 17l-5-5 5-5"/><path d="M4 12h10.5a5.5 5.5 0 0 1 5.5 5.5V18"/></svg>`;
const LIKE_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7.6-4.6-10.1-9.2C.4 8.1 2.4 4.5 5.9 4.5c2 0 3.6 1.1 6.1 3.4 2.5-2.3 4.1-3.4 6.1-3.4 3.5 0 5.5 3.6 4 7.3C19.6 16.4 12 21 12 21z"/></svg>`;

/** 模板列表（内置 + 自定义），用于下拉框与模板管理 */
async function getTemplateList() {
    const settings = getSettings();
    const list = [{ id: DEFAULT_TEMPLATE_ID, name: DEFAULT_TEMPLATE_NAME, builtin: true, source: '内置' }];
    for (const key of BUILTIN_KEYS) {
        // 显示名统一用文件 key（个别 JSON 内部 name 为"未命名"）
        list.push({ id: `builtin:${key}`, name: key, builtin: true, source: '内置' });
    }
    for (const t of settings.customTemplates || []) {
        list.push({ id: t.id, name: t.name, builtin: false, source: '自定义' });
    }
    return list;
}

function createCustomTemplate(name, css, comments) {
    const settings = getSettings();
    const id = `custom_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    settings.customTemplates.push({ id, name: name || '未命名模板', css: css || '', comments: comments || '' });
    saveSettingsDebounced();
    return id;
}

function updateCustomTemplate(id, name, css, comments) {
    const settings = getSettings();
    const t = (settings.customTemplates || []).find((x) => x.id === id);
    if (!t) return false;
    t.name = name || t.name;
    t.css = css ?? t.css;
    if (comments !== undefined) t.comments = comments;
    saveSettingsDebounced();
    return true;
}

function deleteCustomTemplate(id) {
    const settings = getSettings();
    settings.customTemplates = (settings.customTemplates || []).filter((t) => t.id !== id);
    if (settings.activeTemplateId === id) {
        settings.activeTemplateId = DEFAULT_TEMPLATE_ID;
    }
    saveSettingsDebounced();
}

// =====================================================================
// 角色解析
// =====================================================================

function getCurrentCharacter() {
    const context = getContext();
    const idx = context?.characterId ?? -1;
    if (idx >= 0 && characters[idx]) {
        return { index: idx, name: characters[idx].name, avatarFileName: characters[idx].avatar };
    }
    return { index: -1, name: context?.name2 || '角色', avatarFileName: null };
}

/** 读取当前聊天绑定的世界书 + 角色自带书，提取启用且有正文的条目作为 NPC */
let dpWorldNpcsCache = null;
async function loadWorldNpcs() {
    if (dpWorldNpcsCache) return dpWorldNpcsCache;
    const npcs = [];
    const seen = new Set();
    const pushEntries = (entries) => {
        if (!entries || typeof entries !== 'object') return;
        for (const k of Object.keys(entries)) {
            const e = entries[k];
            if (!e) continue;
            const content = typeof e.content === 'string' ? e.content.trim() : '';
            if (!content || content.length < 2) continue;
            const key = (e.comment || (Array.isArray(e.key) && e.key.length ? String(e.key[0]) : '')).trim();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            npcs.push({ name: key.slice(0, 20), content: content.slice(0, 1200) });
        }
    };
    try {
        const ctx = getContext();
        // 1. 角色自带世界书
        const ch = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
        const book = ch && ch.data ? (ch.data.character_book || ch.data.book) : null;
        if (book && book.entries) pushEntries(book.entries);
        // 2. 全局世界书
        try {
            const wi = window.world_info || (ctx && ctx.world_info) || (ctx && ctx.worldInfo);
            if (wi && wi.entries) pushEntries(wi.entries);
        } catch (e) { }
        // 3. 读所有世界书文件（最多10本，合并所有条目）
        try {
            const r = await fetch('/worlds/list.json');
            if (r.ok) {
                const list = await r.json();
                if (Array.isArray(list)) {
                    const files = list.slice(-20);
                    for (const fn of files) {
                        if (npcs.length >= 60) break;
                        try {
                            const r2 = await fetch('/worlds/' + encodeURIComponent(fn) + '.json');
                            if (r2.ok) {
                                const j = await r2.json();
                                if (j && j.entries) pushEntries(j.entries);
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (e) { }
    } catch (e) { console.warn('[晋江段评] 读世界书失败', e); }
    dpWorldNpcsCache = npcs.slice(0, 60);
    return dpWorldNpcsCache;
}
/** 根据下拉框 value 解析评价角色；-1 表示当前角色 */
/** 读当前角色世界书所有条目正文，拼成世界观上下文（自动注入，不需手动选） */
async function loadWorldbookContext() {
    const parts = [];
    try {
        const ctx = getContext();
        const ch = ctx && ctx.characters ? ctx.characters[ctx.characterId] : null;
        const book = ch && ch.data ? (ch.data.character_book || ch.data.book) : null;
        const collectEntries = (entries) => {
            if (!entries || typeof entries !== 'object') return;
            for (const k of Object.keys(entries)) {
                const e = entries[k];
                if (!e) continue;
                const content = typeof e.content === 'string' ? e.content.trim() : '';
                if (!content || content.length < 5) continue;
                const title = (e.comment || (Array.isArray(e.key) && e.key.length ? String(e.key[0]) : '')).trim();
                parts.push(`【${title || '条目'}】${content.slice(0, 800)}`);
            }
        };
        if (book && book.entries) collectEntries(book.entries);
        // 聊天绑定世界书
        let wid = (ctx && ctx.chatMetadata && ctx.chatMetadata.world_info_id) || (ctx && ctx.chat_metadata && ctx.chat_metadata.world_info_id) || null;
        if (wid && typeof wid === 'string' && wid.indexOf('/') < 0) {
            try {
                const r = await fetch('/worlds/' + encodeURIComponent(wid) + '.json');
                if (r.ok) {
                    const j = await r.json();
                    if (j && j.entries) collectEntries(j.entries);
                }
            } catch (e) { }
        }
    } catch (e) { }
    return parts.slice(0, 30).join('\n\n');
}
function resolveRater(value) {
    const v0 = String(value);
    if (v0.startsWith('npc:')) {
        const ni = Number(v0.slice(4));
        const npc = (dpWorldNpcsCache || [])[ni];
        if (npc) return { name: npc.name, avatarFileName: null, index: -1, isNpc: true, npcContent: npc.content };
    }
    const sel = Number(value);
    if (sel === -1 || !characters[sel]) {
        const cur = getCurrentCharacter();
        return { name: cur.name, avatarFileName: cur.avatarFileName, index: cur.index };
    }
    return { name: characters[sel].name, avatarFileName: characters[sel].avatar, index: sel };
}

function avatarUrlFor(fileName) {
    if (!fileName) return null;
    return `${location.origin}/characters/${encodeURIComponent(fileName)}`;
}

// =====================================================================
// 段评卡片渲染（iframe 隔离）
// =====================================================================

function buildCardHtml({
    quote,
    authorName,
    avatarUrl,
    dateStr: ds,
    dateCn: dcn,
    title,
    chapter,
    sourceLine,
    watermark,
    quoteSize,
    quoteLh,
    quoteLs,
    wmTitle = '',
    wmSub = '',
    extra = '',
    beName = '',
}) {
    const avatarBlock = avatarUrl
        ? `<div class="be-char-avatar" style="width:42px;height:42px;flex-shrink:0;border-radius:50%;background-image:url(${esc(avatarUrl)});background-size:cover;background-position:center;display:inline-block"></div>`
        : `<div class="be-char-avatar"></div>`;
    return `
    <div class="be-card be-custom" style="--be-quote-size:${quoteSize}px;--be-quote-lh:${quoteLh};--be-quote-ls:${quoteLs}em">
      <div class="be-head">
        <div class="be-meta">
          <div class="be-source">
            ${avatarBlock}
            <span class="author">${esc(authorName)}</span>
            <span class="title">${esc(title)}</span>
            <span class="chapter">${esc(chapter)}</span>
          </div>
        </div>
        <span class="be-name">${esc(beName || `@${(typeof name1==='string'&&name1)?name1:'用户'}`)}</span>
      </div>
      <div class="be-quote">${esc(quote)}</div>
      <div class="be-quote-orig">${esc(sourceLine)}</div>
      <div class="be-date">${esc(ds)}</div>
      <div class="be-date-cn">${esc(dcn)}</div>
      <div class="be-watermark">${esc(watermark)}${wmTitle ? `<span class="be-wm-title">${esc(wmTitle)}</span>` : ''}${wmSub ? `<span class="be-wm-sub">${esc(wmSub)}</span>` : ''}</div>
      ${extra}
    </div>`;
}

// 按歌名/歌手程序化生成唱片风专辑封面（dataURL SVG）
function makeAlbumCover(title, artist) {
    let h = 0;
    const s = String(title || '') + '|' + String(artist || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hue1 = h % 360, hue2 = (hue1 + 50 + (h % 70)) % 360;
    const t = String(title || '♪').slice(0, 9);
    const a = String(artist || '').slice(0, 12);
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>` +
        `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue1},62%,46%)'/><stop offset='1' stop-color='hsl(${hue2},66%,30%)'/></linearGradient></defs>` +
        `<rect width='160' height='160' fill='url(#g)'/>` +
        `<circle cx='80' cy='68' r='32' fill='rgba(0,0,0,0.28)'/><circle cx='80' cy='68' r='9' fill='#fff'/>` +
        `<text x='80' y='128' font-size='15' text-anchor='middle' fill='#fff' font-family='sans-serif' font-weight='bold'>${t}</text>` +
        `<text x='80' y='146' font-size='10' text-anchor='middle' fill='rgba(255,255,255,0.85)' font-family='sans-serif'>${a}</text>` +
        `</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function buildMomentsCardHtml({ name, avatarUrl, text, time, bgm, musicMode, replies }) {
    const av = esc(avatarUrl || '');
    const nm = esc(name || '');
    const tx = esc(text || '');
    const tm = esc(time || '');
    const DEFAULT_MUSIC_COVER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><rect width='80' height='80' fill='%2334495e'/><circle cx='40' cy='40' r='25' fill='%232c3e50'/><text x='40' y='55' font-size='30' text-anchor='middle' fill='%23ecf0f1'>&#9834;</text></svg>";
    const bgmOn = bgm && bgm.title;
    const mcCover = musicMode ? (bgmOn ? makeAlbumCover(bgm.title, bgm.artist) : DEFAULT_MUSIC_COVER) : '$';
    const mcTitle = musicMode ? (bgmOn ? esc(bgm.title) : '点击播放') : '$';
    const mcAuthor = musicMode ? (bgmOn ? esc(bgm.artist) : 'SillyTavern') : '$';
    const mcStyle = musicMode ? '' : ' style="display:none"';
    const asyncCoverJs = musicMode
        ? "(function(){var t=document.getElementById('qm_render_music_title');var img=document.getElementById('qm_render_music_cover');if(!t||!img||!t.textContent||t.textContent==='点击播放')return;var a=document.getElementById('qm_render_music_author');var q=encodeURIComponent(t.textContent+' '+(a?a.textContent:''));fetch('https://music-api.gdstudio.xyz/api.php?types=search&count=5&source=netease&name='+q).then(function(r){return r.json();}).then(function(list){if(!list||!list[0]||!list[0].id)return null;return fetch('https://music-api.gdstudio.xyz/api.php?types=pic&source=netease&id='+list[0].id);}).then(function(r){return r?r.json():null;}).then(function(j){if(j&&j.url){img.src=j.url;}}).catch(function(){});})();"
        : '';    const repliesHtml = (replies && replies.length)
        ? `<div class="qm-replies">` + replies.map((r) => `<div class="qm-reply"><b>${esc(r.authorName || '')}</b>：${esc(r.text || '')}</div>`).join('') + `</div>`
        : '';
    return `<style>
.Qixian-moments-wrap{display:flex;padding:16px 15px;background:#ffffff;border-bottom:1px solid #f0f0f0;font-family:-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;user-select:none;-webkit-tap-highlight-color:transparent;box-sizing:border-box;}
.Qixian-moments-avatar{width:42px;height:42px;border-radius:4px;background-color:#eaeaea;object-fit:cover;flex-shrink:0;}
.Qixian-moments-body{margin-left:10px;flex-grow:1;display:flex;flex-direction:column;min-width:0;}
.Qixian-moments-name{color:#576b95;font-size:16px;font-weight:500;margin-bottom:4px;cursor:pointer;line-height:1.2;}
.Qixian-moments-text{font-size:15px;color:#111111;line-height:1.45;margin-bottom:10px;word-break:break-word;white-space:pre-wrap;}.Qixian-moments-music{display:flex;align-items:center;background:#f7f7f7;padding:5px;border-radius:2px;margin-bottom:10px;cursor:pointer;width:100%;box-sizing:border-box;}.Qixian-moments-music-cover{width:40px;height:40px;position:relative;background:#e1e1e1;flex-shrink:0;}.Qixian-moments-music-cover img{width:100%;height:100%;object-fit:cover;}.Qixian-moments-music-play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:22px;height:22px;border-radius:50%;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;}.Qixian-moments-music-play svg{width:10px;height:10px;fill:#fff;margin-left:2px;}.Qixian-moments-music-info{margin-left:8px;display:flex;flex-direction:column;justify-content:center;overflow:hidden;}.Qixian-moments-music-title{font-size:14px;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;margin-bottom:2px;}.Qixian-moments-music-author{font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2;}
.Qixian-moments-location{font-size:12px;color:#576b95;margin-bottom:10px;cursor:pointer;display:inline-block;}
.Qixian-moments-footer{display:flex;justify-content:space-between;align-items:center;position:relative;height:24px;}
.Qixian-moments-time{font-size:12.5px;color:#b2b2b2;}
.Qixian-moments-action-trigger{width:32px;height:20px;background:#f7f7f7;border-radius:4px;display:flex;align-items:center;justify-content:space-evenly;cursor:pointer;padding:0 6px;box-sizing:border-box;}
.Qixian-moments-action-trigger .dot{width:4px;height:4px;background-color:#576b95;border-radius:50%;}
.Qixian-moments-popover{position:absolute;right:42px;top:-8px;background:#4c5154;border-radius:4px;display:flex;align-items:center;overflow:hidden;width:0;opacity:0;height:38px;transition:width .2s cubic-bezier(.25,.1,.25,1),opacity .2s ease;white-space:nowrap;}
.Qixian-moments-popover.active{width:180px;opacity:1;}
.Qixian-moments-pop-item{flex:1;display:flex;justify-content:center;align-items:center;height:100%;color:#fff;font-size:14px;font-weight:500;cursor:pointer;}
.Qixian-moments-pop-item svg{width:16px;height:16px;fill:transparent;stroke:#fff;stroke-width:1.5;margin-right:4px;}
.Qixian-moments-divider{width:1px;height:20px;background:#373d40;}.qm-replies{margin:4px 0 10px;}.qm-reply{background:#f2f2f2;border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:14px;color:#111;line-height:1.4;}.qm-reply b{color:#576b95;font-weight:500;margin-right:4px;}
</style>
<div class="Qixian-moments-wrap" id="QixianMomentsRoot">
<span id="qm_avatar" style="display:none">${av}</span>
<span id="qm_name" style="display:none">${nm}</span>
<span id="qm_text" style="display:none">${tx}</span>
<span id="qm_music_cover" style="display:none">${mcCover}</span>
<span id="qm_music_title" style="display:none">${mcTitle}</span>
<span id="qm_music_author" style="display:none">${mcAuthor}</span>

<span id="qm_time" style="display:none">${tm}</span>
<img class="Qixian-moments-avatar" id="qm_render_avatar" src="" alt="avatar">
<div class="Qixian-moments-body">
<div class="Qixian-moments-name" id="qm_render_name"></div>
<div class="Qixian-moments-text" id="qm_render_text"></div>
<div class="Qixian-moments-music"${mcStyle}>
  <div class="Qixian-moments-music-cover"><img id="qm_render_music_cover" src="" alt="cover"><div class="Qixian-moments-music-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>
  <div class="Qixian-moments-music-info"><div class="Qixian-moments-music-title" id="qm_render_music_title"></div><div class="Qixian-moments-music-author" id="qm_render_music_author"></div></div>
</div>
<div class="Qixian-moments-location" id="qm_render_location"><svg width="11" height="11" viewBox="0 0 24 24" style="vertical-align:-1px;margin-right:3px;fill:#576b95"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>sillytavern</div>
${repliesHtml}
<div class="Qixian-moments-footer">
<div class="Qixian-moments-time" id="qm_render_time"></div>
<div class="Qixian-moments-popover" id="qm_action_popover">
<div class="Qixian-moments-pop-item"><svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>赞</div>
<div class="Qixian-moments-divider"></div>
<div class="Qixian-moments-pop-item"><svg viewBox="0 0 24 24" stroke-linejoin="round" stroke-linecap="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>评论</div>
</div>
<div class="Qixian-moments-action-trigger" id="qm_action_btn"><div class="dot"></div><div class="dot"></div></div>
</div>
</div>
</div>
<script>
(function(){
function val(id){var e=document.getElementById(id);return e?e.textContent:'';}
function setImg(r,s){var r2=document.getElementById(r),v=val(s).trim();if(r2&&v&&v.indexOf('$')!==0)r2.src=v;}
function setText(r,s){var r2=document.getElementById(r),v=val(s).trim();if(r2&&v&&v.indexOf('$')!==0)r2.textContent=v;else if(r2&&(!v||v.indexOf('$')===0))r2.style.display='none';}
setImg('qm_render_avatar','qm_avatar');
setImg('qm_render_music_cover','qm_music_cover');
setText('qm_render_music_title','qm_music_title');
setText('qm_render_music_author','qm_music_author');
setText('qm_render_name','qm_name');
setText('qm_render_text','qm_text');
/* loc fixed */
setText('qm_render_time','qm_time');
function pickFile(cb){var inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.onchange=function(){var f=inp.files[0];if(!f)return;var r=new FileReader();r.onload=function(){cb(r.result);};r.readAsDataURL(f);};inp.click();}
var avEl=document.getElementById('qm_render_avatar');if(avEl){avEl.style.cursor='pointer';avEl.title='点击更换头像';avEl.addEventListener('click',function(){pickFile(function(u){avEl.src=u;});});}
var nmEl=document.getElementById('qm_render_name');if(nmEl){nmEl.style.cursor='pointer';nmEl.title='点击修改昵称';nmEl.addEventListener('click',function(){var v=prompt('修改昵称',nmEl.textContent||'');if(v!==null)nmEl.textContent=v;});}
var covBox=document.querySelector('.Qixian-moments-music-cover');var covEl=document.getElementById('qm_render_music_cover');if(covBox&&covEl){covBox.style.cursor='pointer';covBox.title='点击更换专辑封面';covBox.addEventListener('click',function(e){e.stopPropagation();pickFile(function(u){covEl.src=u;});});}
var btn=document.getElementById('qm_action_btn'),po=document.getElementById('qm_action_popover'),root=document.getElementById('QixianMomentsRoot');
if(btn&&po&&root){
btn.addEventListener('click',function(e){e.stopPropagation();po.classList.toggle('active');});
root.addEventListener('click',function(){if(po.classList.contains('active'))po.classList.remove('active');});
po.addEventListener('click',function(e){e.stopPropagation();});
}
})();
</` + `script>`;
}

function buildCommentsHtml(comments) {
    if (!comments || !comments.length) return '';
    const rows = comments.map((c) => {
        const avatarHtml = c.avatarUrl
            ? `<div class="be-comment-avatar" style="background-image:url('${esc(c.avatarUrl)}')"></div>`
            : `<div class="be-comment-avatar be-comment-avatar-fallback">${esc((c.authorName || '评')[0] || '评')}</div>`;
        const idHtml = c.authorHandle ? `<span class="be-comment-id">${esc(c.authorHandle)}</span>` : '';
        return `<div class="be-comment" data-kind="${c.kind === 'user' ? 'user' : 'char'}">
          ${avatarHtml}
          <div class="be-comment-main">
            <div class="be-comment-meta">
              <span class="be-comment-name">${esc(c.authorName)}</span>
              ${idHtml}
            </div>
            <div class="be-comment-text">${esc(c.text)}</div>
            <div class="be-comment-actions">
              <span class="be-act" title="回评">${REPLY_ICON}</span>
              <span class="be-act" title="点赞">${LIKE_ICON}</span>
            </div>
          </div>
        </div>`;
    }).join('');
    return `<div class="be-comments">${rows}</div>`;
}

function findCharByName(name) {
    if (!name) return null;
    return characters.find((c) => c.name === name) || null;
}

/** 取当前生效字体的完整 @font-face CSS（IndexedDB / 单字体 base64 / 字体文件直链） */
async function loadFontCssText(st) {
    if (!st) st = getSettings();
    // 跨域兜底：fetch 分片失败时改用浏览器原生 @import 加载（不依赖 fetch CORS）
    if (st.fontCssKey && st.fontCssKey.indexOf('link:') === 0) return '@import url("' + st.fontCssKey.slice(5) + '");';
    if (st.fontCssKey) {
        const v = await idbGet(st.fontCssKey);
        if (v) return v;
    }
    // 家族名必须与下方 @font-face 声明的家族名一致，否则浏览器找不到对应字体 → 字体“无效”
    const fam = st.fontFamily || 'dp-font-custom';
    if (st.fontB64 && /^data:(font\/|application\/font|application\/octet-stream)/i.test(st.fontB64)) return '@font-face{font-family:"' + fam + '";src:url("' + st.fontB64 + '")}';
    // 直链兜底只允许真正的字体文件（.ttf/.woff/.woff2/.otf）；
    // 若 fontUrl 是 .css 链接（且分片下载失败）就返回空串，避免把 CSS 当字体 src 导致静默失效
    if (st.fontUrl && st.fontUrl.indexOf('@import') !== 0 && /^https?:/i.test(st.fontUrl) && /\.(woff2?|ttf|otf)(\?|#|$)/i.test(st.fontUrl)) {
        return '@font-face{font-family:"' + fam + '";src:url("' + st.fontUrl + '")}';
    }
    return '';
}

async function renderCard() {
    const frame = document.getElementById('dp-frame');
    if (!frame) return;

    const settings = getSettings();
    await ensureFontB64(settings, true); // quiet：后台渲染不弹字体失败提示，避免每次输入都刷 toast
    const quoteInput = document.getElementById('dp-quote-input');
    if (!quoteInput) return;

    const quote = quoteInput.value;
    const key = getTemplateKey(settings.activeTemplateId);
    const title = settings.bookTitle ? `《${settings.bookTitle}》` : '《晋江文学城》';
    const chapter = settings.chapterText || (dp.selection ? `第${dp.selection.mesIndex + 1}条` : '段评');
    const sourceLine = dp.selection && dp.selection.author
        ? `—— 选自《${settings.bookTitle || '晋江文学城'}》${chapter} · ${dp.selection.author}`
        : `—— 选自《${settings.bookTitle || '晋江文学城'}》${chapter}`;
    const watermark = settings.watermarkText || '';

    // 正文卡片作者 = 原话作者（选中段落的发言角色），无则用当前角色
    let authorName = (dp.selection && dp.selection.author) || getCurrentCharacter().name;
    let authorAvatar = null;
    if (dp.selection && dp.selection.author) {
        const ch = findCharByName(dp.selection.author);
        if (ch) authorAvatar = avatarUrlFor(ch.avatar);
    } else {
        authorAvatar = avatarUrlFor(getCurrentCharacter().avatarFileName);
    }

    // 小狗日记小票：标题“小狗日记/欢迎光临”原由 ::before/::after 伪元素渲染，
    // html2canvas 下载时会丢失伪元素文本 → 改为真实 span 元素（禁用模板伪元素）
    const isTicket = key === '小狗日记小票';
    const wmTitle = isTicket ? '小狗日记' : '';
    const wmSub = isTicket ? '欢迎光临sillytavern' : '';
    const wmRealCss = isTicket
        ? '.be-card.be-custom .be-watermark::before,.be-card.be-custom .be-watermark::after{content:none!important}'
        : '';
    const ticketDateCss = isTicket
        ? '.be-card.be-custom .be-date{display:block!important;visibility:visible!important}'
        : '';

    const commentsInside = await resolveTemplateCommentsInside(settings.activeTemplateId);
    const commentsHtml = buildCommentsHtml(dp.comments || []);
    const stickersHtml = buildStickersHtml(settings.stickers || []);
    // 打孔拼贴诗：启用拼贴模式且存在词条时，卡片 = 背景图 1:1 + 纸片词条（替代普通段评内容）
    const isBgTpl = key === '背景图';
    const collageActive = isBgTpl && settings.collageEnabled && (settings.collageWords || []).length > 0;
    let collageCardHtml = '';
    if (collageActive) {
        const gimg = await collageEnsureImage();
        const csize = collageImgSize();
        if (settings.bgImage) {
            // 卡片尺寸优先取背景图实际尺寸（避免旧尺寸缓存导致图片被拉伸）
            const cw = (gimg && gimg.img && gimg.img.naturalWidth > 0) ? gimg.img.naturalWidth : (csize ? csize.W : 1080);
            const ch = (gimg && gimg.img && gimg.img.naturalHeight > 0) ? gimg.img.naturalHeight : (csize ? csize.H : 1470);
            const inner = buildCollageHtml(settings.collageWords, cw, ch);
            // 卡片宽度取背景图实际宽；高度由 img height:auto 按原图比例自动撑起（图片永不拉伸）
            collageCardHtml = `<div class="be-card be-custom dp-collage-card" style="width:${cw}px;position:relative;overflow:hidden;box-sizing:border-box;"><img src="${settings.bgImage}" alt="" style="display:block;width:100%;height:auto;z-index:0;pointer-events:none;">${inner}</div>`;
        } else if (settings.collageWords.length) {
            // 无背景图：纯色画布拼贴（默认浅色，避免纯黑观感）
            const w0 = csize ? csize.W : 1080;
            const h0 = csize ? csize.H : 1470;
            const inner = buildCollageHtml(settings.collageWords, w0, h0);
            collageCardHtml = `<div class="be-card be-custom dp-collage-card" style="width:${w0}px;height:${h0}px;background-color:${settings.collageBgColor || '#f5eedd'};position:relative;overflow:hidden;box-sizing:border-box;">${inner}</div>`;
        }
    }
    let html;
    if (key === '朋友圈' || key === '朋友圈纯文字' || key === '朋友圈夜间' || key === '朋友圈纯文字夜间') {
        const c0 = (dp.comments && dp.comments[0]) || null;
        html = buildMomentsCardHtml({
            name: c0 ? c0.authorName : authorName,
            avatarUrl: c0 ? c0.avatarUrl : authorAvatar,
            text: quote,
            time: dateStr(),
            bgm: c0 && c0.bgmTitle ? { title: c0.bgmTitle, artist: c0.bgmArtist } : null,
            musicMode: key.includes('朋友圈') && !key.includes('纯文字'),
            dark: key.includes('夜间'),
            replies: (dp.comments || []),
        });
        if (key.includes('夜间')) {
            html = html.replace('#ffffff','#17171a').replace('#f0f0f0','#2a2a2e').replace('#576b95','#e8e8e8').replace('#111111','#ffffff').replace('#f7f7f7','#26262a').replace('#e1e1e1','#333333').replace('#888888','#bbbbbb').replace('#b2b2b2','#888888').replace('#4c5154','#2c2c30').replace('#373d40','#1a1a1a').replace('#f2f2f2','#2a2e35').replace('color:#111;','color:#ffffff;').replace('color:#888;','color:#bbbbbb;')
        // 强制覆盖评论区/正文所有文字为浅色（String.replace 只替换首个匹配，评论正文 color:#111 漏了）
        html = html.replace('</style>', '.Qixian-moments-wrap{background:#17171a!important;}.Qixian-moments-text{color:#e8e8e8!important;}.Qixian-moments-name{color:#7ab8ff!important;}.Qixian-moments-location{color:#7ab8ff!important;}.Qixian-moments-music-title{color:#e8e8e8!important;}.Qixian-moments-music-author{color:#999!important;}.Qixian-moments-time{color:#888!important;}.qm-replies .qm-reply{background:#2a2e35!important;color:#e0e0e0!important;}.qm-replies .qm-reply b{color:#7ab8ff!important;}.Qixian-moments-action-trigger{background:#2a2e35!important;}.Qixian-moments-action-trigger .dot{background:#7ab8ff!important;}</style>');
        }
    } else {
    html = collageCardHtml || (buildCardHtml({
        quote,
        authorName,
        avatarUrl: authorAvatar,
        dateStr: isTicket ? `${dateStr()} ${new Date().toTimeString().slice(0, 5)}` : dateStr(),
        dateCn: dateCn(),
        title,
        chapter,
        sourceLine,
        quoteSize: Number(settings.quoteSize) || 15,
        quoteLh: Number(settings.quoteLh) || 1.6,
        quoteLs: Number(settings.quoteLs) || 0,
        wmTitle,
        wmSub,
        // 小票模板：水印文字替代 02 行的 @角色名（保留 02 序号与价格），不进顶部标题区
        beName: isTicket && watermark ? watermark : '',
        watermark: isTicket ? '' : watermark,
        extra: commentsInside ? commentsHtml : '',
    }) + (commentsInside ? '' : commentsHtml) + stickersHtml);
    }

    const css = await resolveTemplateCss(settings.activeTemplateId);
    const commentCss = await resolveTemplateComments(settings.activeTemplateId);
    const tplNight = settings.nightMode ? await resolveTemplateNight(settings.activeTemplateId) : '';
    const nightCss = settings.nightMode ? NIGHT_CSS : '';
    const cardW = Number(settings.cardWidth);
    const widthCss = (cardW > 0)
        ? `.dp-card-wrap{width:${cardW}px!important;max-width:none!important}.be-card.be-custom{width:100%!important;max-width:${cardW}px!important}`
        : '';
    // 背景图模板：图片背景 + 透明底文字（无水印/角色名/选自），文字可拖动、改色、改字号
    // （拼贴模式 collageCardHtml 非空时，普通背景图 CSS 与文字拖动全部跳过）
    const bgCss = (isBgTpl && !collageCardHtml) && settings.bgImage
        ? `.be-card.be-custom{background-image:url('${settings.bgImage}')!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important}`
        : '';
    const fontFacesCss = await loadFontCssText(settings);
    const fam = settings.fontFamily || 'dp-font-custom';
    const fontCss = fontFacesCss
        ? `${fontFacesCss}.dp-card-wrap,.dp-card-wrap *{font-family:"${fam}",-apple-system,"PingFang SC","Microsoft YaHei",sans-serif!important}`
        : '';
    const offX = Number(settings.textOffsetX) || 0;
    const offY = Number(settings.textOffsetY) || 0;
    const textOffsetCss = (isBgTpl && !collageCardHtml) && (offX || offY)
        ? `.be-card.be-custom .be-quote{transform:translate(${offX}px,${offY}px)!important}`
        : '';
    const bgTxtCss = (isBgTpl && !collageCardHtml)
        ? `.be-card.be-custom .be-quote{color:${settings.textColor || '#ffffff'}!important;font-size:${Number(settings.bgQuoteSize) || 22}px!important;line-height:${Number(settings.bgQuoteLh) || 1.8}!important}`
        : '';

    const doc = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<base href="${location.origin}/">
<style>${css}</style>
<style>${CARD_BASE_CSS}</style>
<style>${commentCss}</style>
${widthCss ? `<style>${widthCss}</style>` : ''}
${wmRealCss ? `<style>${wmRealCss}</style>` : ''}
${ticketDateCss ? `<style>${ticketDateCss}</style>` : ''}
${nightCss ? `<style>${nightCss}</style>` : ''}
${tplNight ? `<style>${tplNight}</style>` : ''}
${bgCss ? `<style>${bgCss}</style>` : ''}
${bgTxtCss ? `<style>${bgTxtCss}</style>` : ''}
${fontCss ? `<style>${fontCss}</style>` : ''}
${textOffsetCss ? `<style>${textOffsetCss}</style>` : ''}
</head>
<body style="overflow:hidden;margin:0;padding:0;">
<div class="dp-card-wrap" style="overflow:hidden;">
${html}
</div>
<script>
(function(){function pickFile(cb){var inp=document.createElement('input');inp.type='file';inp.accept='image/*';inp.onchange=function(){var f=inp.files[0];if(!f)return;var r=new FileReader();r.onload=function(){cb(r.result);};r.readAsDataURL(f);};inp.click();}document.querySelectorAll('.be-char-avatar, .be-comment-avatar, .Qixian-moments-avatar').forEach(function(el){if(el.dataset.dpBound)return;el.dataset.dpBound=1;el.style.cursor='pointer';el.title='点击更换头像';el.addEventListener('click',function(){pickFile(function(u){if(el.tagName==='IMG'){el.src=u;}else{el.style.backgroundImage="url('"+u+"')";}});});});document.querySelectorAll('.be-source .author, .be-comment-name, .Qixian-moments-name, .be-comment-id, .be-wm-title, .be-wm-sub, .be-source .title, .be-source .chapter, .be-name').forEach(function(el){if(el.id==='qm_render_name')return;if(el.dataset.dpBound)return;el.dataset.dpBound=1;el.style.cursor='pointer';el.title='点击修改文字';el.addEventListener('click',function(){var v=prompt('修改文字',el.textContent||'');if(v!==null)el.textContent=v;});});var cardEl=document.querySelector('.be-card');if(cardEl&&!cardEl.dataset.dpBgDbl){cardEl.dataset.dpBgDbl=1;cardEl.title='双击卡片空白处可上传背景图';cardEl.addEventListener('dblclick',function(e){if(e.target.closest('img,a,button,.be-quote,.be-comment,.be-source,.be-avatar,.be-char-avatar,.be-comment-avatar,.Qixian-moments-music,.Qixian-moments-avatar,.be-name,.author'))return;pickFile(function(u){var bg=cardEl.querySelector('.dp-ins-bg');if(!bg){bg=cardEl.ownerDocument.createElement('div');bg.className='dp-ins-bg';bg.style.cssText='position:absolute;top:0;left:0;right:0;height:120px;background-size:cover;background-position:center;background-repeat:no-repeat;z-index:1;pointer-events:none;';cardEl.insertBefore(bg,cardEl.firstChild);}bg.style.backgroundImage="url('"+u+"')";});});}var wmEl=document.querySelector('.be-watermark');if(wmEl&&!wmEl.dataset.dpWm){wmEl.dataset.dpWm=1;wmEl.style.cursor='pointer';wmEl.title='点击修改顶部文字';wmEl.addEventListener('click',function(){var v=prompt('修改顶部文字',wmEl.textContent||'');if(v!==null&&wmEl.firstChild)wmEl.firstChild.nodeValue=v;});}})();
</script>
</body>
</html>`;
    // srcdoc 内容未变则不重建 iframe（内置模板含大体积 base64，重建昂贵）
    if (frame._lastSrcdoc !== doc) {
        frame._lastSrcdoc = doc;
        frame.srcdoc = doc;
        // srcdoc 刚赋值时 iframe 内部 DOM 尚未解析完成，fitFrame/贴纸拖拽此时执行会落空；
        // 等 load 事件后 DOM 就绪再执行一次，确保首次渲染尺寸与贴纸拖拽都绑定成功
        frame.addEventListener('load', async () => {
            try {
                const idoc = frame.contentDocument;
                const fam0 = (settings.fontFamily || 'dp-font-custom').replace(/["']/g, '');
                if (idoc && fam0) {
                    const chars = new Set();
                    const wrap0 = idoc.querySelector('.dp-card-wrap');
                    if (wrap0) String(wrap0.textContent || '').split('').forEach((c) => { if (c.trim()) chars.add(c); });
                    // 先把全部分片主动 fetch 进浏览器缓存（响应头 immutable，命中后 iframe 引用不再走按需加载）
                    try {
                        const shards = settings._fontShards || [];
                        const CONC = 16;
                        for (let i = 0; i < shards.length; i += CONC) {
                            await Promise.all(shards.slice(i, i + CONC).map((u) => fetch(u, { mode: 'cors' }).catch(() => null)));
                        }
                    } catch (e) { /* 忽略 */ }
                    // 双路预热：iframe 内 + 主文档都加载分片。主文档加载后进浏览器 HTTP 缓存，
                    // iframe 引用同一批 woff2 直接命中缓存——避免 iframe srcdoc 里分片按需加载不全导致“只生效几个字”
                    try {
                        let pre = document.getElementById('dp-font-preload-style');
                        if (!pre) { pre = document.createElement('style'); pre.id = 'dp-font-preload-style'; document.head.appendChild(pre); }
                        pre.textContent = fontFacesCss || '';
                    } catch (e) { /* 忽略 */ }
                    for (const ch of chars) {
                        try { await idoc.fonts.load('32px "' + fam0 + '"', ch); } catch (e) { /* 忽略 */ }
                        try { await document.fonts.load('32px "' + fam0 + '"', ch); } catch (e) { /* 忽略 */ }
                    }
                    try { await idoc.fonts.ready; } catch (e) { /* 忽略 */ }
                    try { await document.fonts.ready; } catch (e) { /* 忽略 */ }
                }
            } catch (e) { /* 忽略 */ }
            fitFrame();
            attachStickerDrag(frame);
            attachCollageDrag(frame);
            if (isBgTpl && !collageCardHtml) attachTextDrag(frame);
        }, { once: true });

    }
    fitFrame();
    attachStickerDrag(frame);
    attachCollageDrag(frame);
    if (isBgTpl && !collageCardHtml) attachTextDrag(frame);
}

function fitFrame() {
    const frame = document.getElementById('dp-frame');
    if (!frame || !frame.contentDocument) return;
    const card = frame.contentDocument.querySelector('.dp-card-wrap') || frame.contentDocument.querySelector('.be-card');
    if (!card) return;
    const w = Math.ceil(card.scrollWidth) + 2;
    const h = Math.ceil(card.scrollHeight) + 2;
    // 仅手机视口（窗口 ≤700px）才等比缩小；桌面保持真实宽度（超宽时预览区横向滚动）
    // 修复：桌面面板容器窄于卡片时不再误缩放，设多宽就显示多宽
    const isMobileViewport = (typeof window !== 'undefined') && window.innerWidth > 0 && window.innerWidth <= 700;
    const box = frame.parentElement;
    const avail = box ? Math.max(0, box.clientWidth - 2) : 0;
    if (isMobileViewport && avail > 0 && w > avail) {
        const ratio = Math.min(1, avail / w);
        frame.style.width = `${avail}px`;
        frame.style.height = `${Math.ceil(h * ratio)}px`;
        frame.contentDocument.body.style.margin = '0';
        card.style.transformOrigin = 'top left';
        card.style.transform = `scale(${ratio})`;
        frame._scaleRatio = ratio;
        return;
    }
    frame.style.width = `${Math.min(w, 800)}px`;
    frame.style.height = `${h}px`;
    if (card.style.transform) card.style.transform = '';
    frame._scaleRatio = 1;
}

/** 在预览 iframe 内绑定贴纸拖拽（微信式：任意滑动到卡片任意位置） */
function attachStickerDrag(frame) {
    if (!frame || !frame.contentDocument) return;
    const doc = frame.contentDocument;
    const wrap = doc.querySelector('.dp-card-wrap');
    if (!wrap) {
        // iframe 内部 DOM 尚未解析完成（srcdoc 刚赋值），延迟重试；
        // renderCard 的 load 事件兜底也会再次调用本函数
        setTimeout(() => attachStickerDrag(frame), 150);
        return;
    }
    if (wrap._stickerDragBound) return;
    wrap._stickerDragBound = true;

    let dragging = null;

    const contentPos = (e) => {
        const rect = wrap.getBoundingClientRect();
        const ratio = frame._scaleRatio || 1;
        return {
            x: (e.clientX - rect.left) / ratio,
            y: (e.clientY - rect.top) / ratio,
        };
    };

    doc.addEventListener('pointerdown', (e) => {
        const st = e.target.closest ? e.target.closest('.dp-sticker') : null;
        if (!st || e.button === 2) return;
        e.preventDefault();
        const pos = contentPos(e);
        const cur = { x: parseFloat(st.style.left) || 0, y: parseFloat(st.style.top) || 0 };
        dragging = { id: st.dataset.sid, offX: pos.x - cur.x, offY: pos.y - cur.y };
        st.classList.add('dp-sticker-drag');
        try { st.setPointerCapture && st.setPointerCapture(e.pointerId); } catch { /* noop */ }
    });

    doc.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        const pos = contentPos(e);
        const st = doc.querySelector(`[data-sid="${dragging.id}"]`);
        if (st) {
            st.style.left = `${Math.round(Math.max(0, pos.x - dragging.offX))}px`;
            st.style.top = `${Math.round(Math.max(0, pos.y - dragging.offY))}px`;
        }
    });

    const stopDrag = () => {
        if (!dragging) return;
        const st = doc.querySelector(`[data-sid="${dragging.id}"]`);
        if (st) {
            const s = getSettings();
            const item = (s.stickers || []).find((x) => x.id === dragging.id);
            if (item) {
                item.x = parseFloat(st.style.left) || 0;
                item.y = parseFloat(st.style.top) || 0;
                saveSettingsDebounced();
            }
            st.classList.remove('dp-sticker-drag');
        }
        dragging = null;
    };

    doc.addEventListener('pointerup', stopDrag);
    doc.addEventListener('pointercancel', stopDrag);
}

/** 拼贴直操作：iframe 内字纸片可点选/拖动（直接在预览上操作，不另起编辑器板块） */
function attachCollageDrag(frame) {
    if (!frame || !frame.contentDocument) return;
    const doc = frame.contentDocument;
    const card = doc.querySelector('.dp-collage-card');
    if (!card) { setTimeout(() => attachCollageDrag(frame), 150); return; }
    if (card._collageDragBound) return;
    card._collageDragBound = true;
    let dragging = null;
    const size = collageImgSize();
    const W = size ? size.W : 1080;
    const H = size ? size.H : 1470;
    const contentPos = (e) => {
        const rect = card.getBoundingClientRect();
        const ratio = frame._scaleRatio || 1;
        return { x: (e.clientX - rect.left) / ratio, y: (e.clientY - rect.top) / ratio };
    };
    doc.addEventListener('pointerdown', (e) => {
        const w = e.target.closest ? e.target.closest('.dp-collage-word') : null;
        if (!w || e.button === 2) return;
        e.preventDefault();
        wordsCache = Array.prototype.slice.call(card.querySelectorAll('.dp-collage-word'));
        const i = wordsCache.indexOf(w);
        collageState.sel = i;
        syncCollageBarControls();
        wordsCache.forEach((x) => x.classList.toggle('sel', x === w));
        const pos = contentPos(e);
        const cur = { x: (parseFloat(w.style.left) || 0) / 100 * W, y: (parseFloat(w.style.top) || 0) / 100 * H };
        const rz = e.target.closest ? e.target.closest('.dp-collage-resize') : null;
        if (rz) {
            dragging = { i, mode: 'resize', startX: pos.x, startY: pos.y, startW: (parseFloat(w.style.width) || 0) / 100 * W, startH: (parseFloat(w.style.height) || 0) / 100 * H };
        } else {
            dragging = { i, mode: 'move', offX: pos.x - cur.x, offY: pos.y - cur.y };
        }
        w.classList.add('dp-sticker-drag');
        try { w.setPointerCapture && w.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    });
    let wordsCache = [];
    let rafPending = false;
    let lastPos = null;
    const applyDrag = () => {
        rafPending = false;
        if (!dragging || !lastPos) return;
        const pos = lastPos;
        const w = wordsCache[dragging.i];
        if (!w) return;
        if (dragging.mode === 'resize') {
            const nw = Math.max(24, Math.round(dragging.startW + (pos.x - dragging.startX)));
            const nh = Math.max(24, Math.round(dragging.startH + (pos.y - dragging.startY)));
            w.style.width = `${(nw / W * 100).toFixed(3)}%`;
            w.style.height = `${(nh / H * 100).toFixed(3)}%`;
            const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
            set('dp-cb-w', nw);
            set('dp-cb-h', nh);
        } else {
            w.style.left = `${(Math.max(0, pos.x - dragging.offX) / W * 100).toFixed(3)}%`;
            w.style.top = `${(Math.max(0, pos.y - dragging.offY) / H * 100).toFixed(3)}%`;
        }
    };
    doc.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        lastPos = contentPos(e);
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(applyDrag);
    });
    const stopDrag = () => {
        if (!dragging) return;
        const s = getSettings();
        const item = s.collageWords && s.collageWords[dragging.i];
        const w = wordsCache[dragging.i];
        if (item && w) {
            item.x = Math.round((parseFloat(w.style.left) || 0) / 100 * W);
            item.y = Math.round((parseFloat(w.style.top) || 0) / 100 * H);
            if (dragging.mode === 'resize') {
                item.w = Math.max(24, Math.round((parseFloat(w.style.width) || 0) / 100 * W));
                item.h = Math.max(24, Math.round((parseFloat(w.style.height) || 0) / 100 * H));
                const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
                set('dp-cb-w', item.w);
                set('dp-cb-h', item.h);
            }
            saveSettingsDebounced();
        }
        if (w) w.classList.remove('dp-sticker-drag');
        dragging = null;
        lastPos = null;
    };
    doc.addEventListener('pointerup', stopDrag);
    doc.addEventListener('pointercancel', stopDrag);
}

/** 同步拼贴工具条控件为当前选中纸片参数 */
function syncCollageBarControls() {
    const s = getSettings();
    const w = (collageState.sel >= 0 && s.collageWords) ? s.collageWords[collageState.sel] : null;
    if (!w) return;
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    set('dp-cb-shape', w.shape || 'round');
    set('dp-cb-paper', w.paper || 'plain');
    set('dp-cb-bg', w.bg || '#f5eedd');
    set('dp-cb-fg', w.fg || '#333333');
    set('dp-cb-size', w.size || 36);
    set('dp-cb-rot', w.rot || 0);
    set('dp-cb-w', w.w || 120);
    set('dp-cb-h', w.h || 80);
}

/** 拼贴直操作：输入文字添加纸片（参数取工具条当前值，新纸片默认完全居中避让） */
function collageBarAddWord(t) {
    const inp = document.getElementById('dp-cb-input');
    let text = t;
    if (text === undefined) { text = inp ? inp.value.trim() : ''; if (inp) inp.value = ''; }
    text = String(text || '').trim();
    if (!text) { toast('warning', '请先输入文字'); return; }
    const s = getSettings();
    const size = collageImgSize();
    const W = size ? size.W : 1080;
    const H = size ? size.H : 1470;
    const chars = Array.from(text).length;
    const isShort = chars <= 2;
    const bw = Math.max(48, Math.round(chars * (isShort ? 92 : 62)));
    const bh = isShort ? 92 : 66;
    const spot = collageFindSpot(W, H, bw, bh, s.collageWords || []);
    const word = {
        id: `cw_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        text,
        x: spot.x, y: spot.y, w: bw, h: bh,
        rot: Number((document.getElementById('dp-cb-rot') || {}).value) || 0,
        shape: (document.getElementById('dp-cb-shape') || {}).value || 'round',
        paper: (document.getElementById('dp-cb-paper') || {}).value || 'none',
        ah: 'center', av: 'middle',
        bg: (document.getElementById('dp-cb-bg') || {}).value || '#f5eedd',
        fg: (document.getElementById('dp-cb-fg') || {}).value || '#333333',
        size: Math.max(8, Math.min(300, Number((document.getElementById('dp-cb-size') || {}).value) || 20)),
    };
    s.collageWords = s.collageWords || [];
    s.collageWords.push(word);
    saveSettingsDebounced();
    collageState.sel = s.collageWords.length - 1;
    syncCollageBarControls();
    renderCard();
}

/** 拼贴模式开关：贴纸旁的拼贴诗按钮 —— 直接在预览上操作（不另起大板块） */
function toggleCollageBar() {
    const s = getSettings();
    const bar = document.getElementById('dp-collage-bar');
    const btn = document.getElementById('dp-btn-collage-main');
    s.collageEnabled = !s.collageEnabled;
    saveSettingsDebounced();
    if (bar) bar.style.display = s.collageEnabled ? 'flex' : 'none';
    if (btn) btn.textContent = s.collageEnabled ? '✂ 收起拼贴' : '✂ 拼贴诗';
    if (s.collageEnabled && !s.bgImage) toast('warning', '提示：当前无背景图，用纯色画布；可在设置里粘贴/上传背景图后更佳');
    renderCard();
}

/** 背景图模板：文字拖动（仅 key === '背景图'；其它模板不绑定，不影响原有模板） */
function attachTextDrag(frame) {
    if (!frame || !frame.contentDocument) return;
    const doc = frame.contentDocument;
    const wrap = doc.querySelector('.dp-card-wrap');
    if (!wrap) {
        setTimeout(() => attachTextDrag(frame), 150);
        return;
    }
    if (wrap._textDragBound) return;
    wrap._textDragBound = true;
    let dragging = null;
    const contentPos = (e) => {
        const rect = wrap.getBoundingClientRect();
        const ratio = frame._scaleRatio || 1;
        return { x: (e.clientX - rect.left) / ratio, y: (e.clientY - rect.top) / ratio };
    };
    doc.addEventListener('pointerdown', (e) => {
        const q = e.target.closest ? e.target.closest('.be-quote') : null;
        if (!q || e.button === 2) return;
        e.preventDefault();
        const st = getSettings();
        const pos = contentPos(e);
        const cur = { x: Number(st.textOffsetX) || 0, y: Number(st.textOffsetY) || 0 };
        dragging = { offX: pos.x - cur.x, offY: pos.y - cur.y };
        q.classList.add('dp-text-dragging');
        try { q.setPointerCapture && q.setPointerCapture(e.pointerId); } catch { /* noop */ }
    });
    doc.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        const pos = contentPos(e);
        const st = getSettings();
        st.textOffsetX = Math.round(pos.x - dragging.offX);
        st.textOffsetY = Math.round(pos.y - dragging.offY);
        saveSettingsDebounced();
        const q = doc.querySelector('.be-quote');
        if (q) q.style.transform = `translate(${st.textOffsetX}px,${st.textOffsetY}px)`;
    });
    const stopDrag = () => {
        if (!dragging) return;
        dragging = null;
        const q = doc.querySelector('.be-quote');
        if (q) q.classList.remove('dp-text-dragging');
        renderCard();
    };
    doc.addEventListener('pointerup', stopDrag);
    doc.addEventListener('pointercancel', stopDrag);
}

function addSticker(item) {
    const s = getSettings();
    s.stickers = s.stickers || [];
    const frame = document.getElementById('dp-frame');
    let cw = 460;
    let ch = 560;
    try {
        const wrap = frame && frame.contentDocument && frame.contentDocument.querySelector('.dp-card-wrap');
        if (wrap) {
            cw = wrap.scrollWidth || 460;
            ch = wrap.scrollHeight || 560;
        }
    } catch { /* 用默认尺寸 */ }
    const estW = item.type === 'img' ? (item.width || 90) : (item.type === 'kaomoji' ? (item.size || 22) * 4.5 : (item.size || 40));
    const sticker = {
        id: `st_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        type: item.type,
        content: item.content,
        size: item.size || 40,
        width: item.width || 90,
        rot: item.rot || 0,
        x: Math.round(Math.max(4, (cw - estW) / 2 + (Math.random() * 50 - 25))),
        y: Math.round(Math.max(4, ch * 0.32 + (Math.random() * 40 - 20))),
    };
    s.stickers.push(sticker);
    saveSettingsDebounced();
    renderCard();
    renderStickerManageList();
}

/** 渲染贴纸管理列表（贴纸弹窗内：当前卡片已添加的贴纸） */
function renderStickerManageList() {
    const box = document.getElementById('dp-sticker-manage');
    if (!box) return;
    const s = getSettings();
    const list = s.stickers || [];
    if (!list.length) {
        box.innerHTML = '<div class="dp-comment-empty">还没有贴纸，点上方任意贴纸添加到卡片</div>';
        return;
    }
    box.innerHTML = list.map((st) => {
        const thumb = st.type === 'img'
            ? `<img src="${esc(st.content)}" class="dp-stk-manage-thumb">`
            : `<span class="dp-stk-manage-text">${esc(st.content)}</span>`;
        const label = st.type === 'emoji' ? 'Emoji' : st.type === 'kaomoji' ? '颜文字' : '图片';
        const cur = st.type === 'img' ? (st.width || 90) : (st.size || 40);
        return `<div class="dp-arch-row">
          <div class="dp-arch-info" style="display:flex;align-items:center;gap:10px;">
            <div class="dp-stk-manage-icon">${thumb}</div>
            <div style="min-width:0;">
              <div class="dp-arch-time">${label} · ${st.x},${st.y}</div>
              <div class="dp-arch-quote">可拖拽到卡片任意位置</div>
            </div>
          </div>
          <div class="dp-arch-actions" style="align-items:center;gap:6px;">
            <button type="button" class="dp-btn dp-btn-sm dp-stk-size" data-id="${esc(st.id)}" data-d="-1" title="缩小">−</button>
            <span class="dp-stk-size-val">${cur}</span>
            <button type="button" class="dp-btn dp-btn-sm dp-stk-size" data-id="${esc(st.id)}" data-d="1" title="放大">+</button>
            <button type="button" class="dp-btn dp-btn-sm dp-btn-danger dp-stk-del" data-id="${esc(st.id)}">删除</button>
          </div>
        </div>`;
    }).join('');
    box.querySelectorAll('.dp-stk-del').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s2 = getSettings();
            s2.stickers = (s2.stickers || []).filter((x) => x.id !== btn.dataset.id);
            saveSettingsDebounced();
            renderStickerManageList();
            renderCard();
        });
    });
    // 贴纸大小调节（emoji/颜文字调字号，图片调宽度，保持比例）
    box.querySelectorAll('.dp-stk-size').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s2 = getSettings();
            const st = (s2.stickers || []).find((x) => x.id === btn.dataset.id);
            if (!st) return;
            const d = Number(btn.dataset.d) || 0;
            if (st.type === 'img') {
                st.width = Math.min(400, Math.max(24, (st.width || 90) + d * 12));
            } else {
                st.size = Math.min(120, Math.max(12, (st.size || 40) + d * 4));
            }
            saveSettingsDebounced();
            renderStickerManageList();
            renderCard();
        });
    });
}

// =====================================================================
// 调取 App 生成段评
// =====================================================================

/** 判断生成结果是否可能被截断（以未完成的逗号/分号/冒号/破折号等结尾） */
function looksTruncated(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    const tail = s.replace(/[\s"'”』】）》]+$/, '').slice(-1);
    return /[,，;；:：—]$/.test(tail);
}

function cleanRating(raw) {
    let s = String(raw || '').trim();
    s = s.replace(/^[\s>#*]+/, '');
    s = s.replace(/^段评\s*[：:]\s*/, '');
    s = s.replace(/\*\*/g, '');
    s = s.replace(/^["“”']+|["“”']+$/g, '');
    s = s
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^(好的|好的，|好的吧|没问题|没问题，|以下是|这是|作为)[，。:：]?\s*$/.test(l))
        .join('\n');
    return s.trim();
}

// =====================================================================
// 自填 API（可选） / 人设感知 / 角色 @ID
// =====================================================================

function apiConfigured() {
    const s = getSettings();
    return !!(s.apiEnabled && (s.apiUrl || '').trim() && (s.apiModel || '').trim());
}

/** 拉取模型列表（OpenAI 兼容 /models） */
async function fetchModelList() {
    const s = getSettings();
    const url = (s.apiUrl || '').trim().replace(/\/+$/, '');
    if (!url) throw new Error('请先填写 API 地址');
    const headers = { 'Content-Type': 'application/json' };
    if ((s.apiKey || '').trim()) headers.Authorization = `Bearer ${s.apiKey.trim()}`;
    const resp = await fetch(`${url}/models`, { headers });
    if (!resp.ok) throw new Error(`获取模型失败 HTTP ${resp.status}`);
    const data = await resp.json();
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    if (!ids.length) throw new Error('该 API 没有返回模型列表');
    return ids;
}

/** 调取自填 API 生成（OpenAI 兼容 chat/completions） */
async function apiChatComplete(messages) {
    const s = getSettings();
    const url = (s.apiUrl || '').trim().replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if ((s.apiKey || '').trim()) headers.Authorization = `Bearer ${s.apiKey.trim()}`;
    const resp = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: s.apiModel,
            messages,
            temperature: 0.9,
            max_tokens: 1500,
        }),
    });
    if (!resp.ok) {
        let detail = '';
        try { detail = (await resp.json())?.error?.message || ''; } catch { /* ignore */ }
        throw new Error(`API HTTP ${resp.status}${detail ? '：' + detail : ''}`);
    }
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? '';
}

/** 提取角色卡人设（描述/性格/背景设定 + 口吻参考） */
function characterCard(ch) {
    if (!ch) return '';
    const parts = [];
    if (ch.description) parts.push(`【人设·描述】${ch.description}`);
    if (ch.personality) parts.push(`【人设·性格】${ch.personality}`);
    if (ch.scenario) parts.push(`【背景设定】${ch.scenario}`);
    // 口吻参考：开场白 / 备选开场 / 示例对话（各取一小段，用来模仿说话习惯）
    const style = [];
    if (ch.first_mes) style.push(`开场白：${String(ch.first_mes).slice(0, 300)}`);
    if (Array.isArray(ch.alternate_greetings) && ch.alternate_greetings.length && ch.alternate_greetings[0]) {
        style.push(`备选开场：${String(ch.alternate_greetings[0]).slice(0, 300)}`);
    }
    let examples = ch.mesExamples;
    if (typeof examples === 'string') { try { examples = JSON.parse(examples); } catch { examples = null; } }
    if (Array.isArray(examples) && examples.length) {
        try {
            const lines = [];
            const first = Array.isArray(examples[0]) ? examples[0] : [examples[0]];
            for (const pair of first) {
                if (!pair || typeof pair !== 'object') continue;
                const u = pair.user ? String(pair.user).slice(0, 160) : '';
                const c = pair.char ? String(pair.char).slice(0, 160) : '';
                if (u) lines.push(`user：${u}`);
                if (c) lines.push(`char：${c}`);
            }
            if (lines.length) style.push(`口吻示例：\n${lines.slice(0, 6).join('\n')}`);
        } catch { /* 忽略坏格式 */ }
    }
    if (style.length) parts.push(`【说话风格参考】\n${style.join('\n\n')}`);
    return parts.join('\n');
}

/** 从当前聊天历史中提取"剧情在场者"（除用户、当前评价角色外的其他角色名） */
function presentCharacters(rater) {
    const names = new Set();
    const userNames = new Set([typeof name1 === 'string' ? name1 : '', typeof name2 === 'string' ? name2 : '', '用户', 'user', 'system', '匿名', 'unknown'].filter(Boolean));
    try {
        const msgs = Array.isArray(chat) ? chat : [];
        for (const m of msgs) {
            const n = m && m.name;
            if (typeof n !== 'string' || !n.trim()) continue;
            const key = n.trim();
            if (userNames.has(key)) continue;
            if (key === rater.name) continue;
            names.add(key);
        }
    } catch (e) { /* 环境差异忽略 */ }
    return Array.from(names).slice(0, 6);
}

/**
 * 构造评级提示词：人设卡 + 自我意识 + 剧情在场者关系 + 用户模板
 * 当前角色：明确知道这是他与用户正在进行的剧情；
 * 其他角色：知道这是用户与该角色共同经历的剧情；
 * 均不是旁观读者——评价会带上与在场者/用户的关系。
 */
function buildRaterPrompt(rater, quote, extra) {
    const settings = getSettings();
    const user = (typeof name1 === 'string' && name1) ? name1 : '用户';
    const cur = getCurrentCharacter();
    const isSelf = rater.index >= 0 && rater.index === cur.index;
    const ch = rater.index >= 0 ? characters[rater.index] : null;
    let persona = rater.isNpc ? `【人设·世界书条目】${rater.npcContent || ''}` : characterCard(ch);
    const awareness = isSelf
        ? `【重要】你是「${rater.name}」本人（不是旁观者、不是 AI）。下面这段【原文】是**你与「${user}」共同经历过的真实剧情**（可能来自你们的历史存档/过往片段）——你是当事人，不是在追小说，这些事情切实发生在你们之间。请以你本人的人设、性格、语气与说话习惯，对这段剧情发表即时感想；禁止脱离人设（禁止 OOC），可以吐槽、心动、沉默、嘴硬或毒舌，但必须是你本人会说的话。`
        : `【重要】你是「${rater.name}」本人（不是旁观者、不是 AI）。下面这段【原文】是**「${user}」与「${rater.name}」共同经历过的真实剧情**（可能来自历史存档/过往片段），你们是当事人，不是在追小说。请严格以「${rater.name}」本人的人设、性格、语气与说话习惯，对这段剧情发表即时感想；禁止脱离人设（禁止 OOC），完全贴合其说话风格。`;
    const present = presentCharacters(rater);
    const presentBlock = present.length
        ? `\n【剧情在场者】这段剧情发生时，还有以下角色在场：${present.join('、')}。你与他们的关系以你人设中的设定为准——评价时自然地带上这份关系（可以提到他们、回应他们，但不要编造他们说过的话或没有发生过的剧情）。`
        : '';
    let presentPersonsBlock = '';
    try {
        const pc = present
            .map((nm) => {
                const c = characters.find((x) => x && x.name === nm);
                const card = c ? characterCard(c) : '';
                return card ? `——「${nm}」：\n${card}` : '';
            })
            .filter(Boolean);
        if (pc.length) presentPersonsBlock = `\n【在场角色人设（涉及他们时请按这些设定理解，不要 OOC、不要编造他们的剧情）】\n${pc.join('\n\n')}`;
    } catch (e) { /* 忽略 */ }
    let recentBlock = '';
    try {
        const msgs = Array.isArray(chat) ? chat : [];
        const tail = msgs.slice(-6);
        const lines = [];
        for (const m of tail) {
            const n = (m && m.name) ? String(m.name) : '';
            const t = (m && m.mes) ? String(m.mes).replace(/\s+/g, ' ').trim().slice(0, 120) : '';
            if (n && t) lines.push(`${n}：${t}`);
        }
        if (lines.length) recentBlock = `\n【当前剧情进展（最近的对话，供你理解上下文与当前氛围，不要照抄、不要复述）】\n${lines.join('\n')}`;
    } catch (e) { /* 忽略 */ }
    let presetBlock = '';
    try {
        let oai = {}; try { oai = JSON.parse(localStorage.getItem('oai_settings') || '{}'); } catch (e) {} if (!oai || !Object.keys(oai).length) { const ctx0 = getContext(); oai = (ctx0 && (ctx0.chatCompletionSettings || ctx0.oai_settings || ctx0.preset_settings)) || {}; }
        const pl = [];
        if (typeof oai.system_prompt === 'string' && oai.system_prompt.trim()) pl.push(`【系统提示】${oai.system_prompt.trim().slice(0, 800)}`);
        if (typeof oai.main_prompt === 'string' && oai.main_prompt.trim()) pl.push(`【主提示词】${oai.main_prompt.trim().slice(0, 800)}`);
        if (typeof oai.jailbreak_prompt === 'string' && oai.jailbreak_prompt.trim()) pl.push(`【深层指令】${oai.jailbreak_prompt.trim().slice(0, 800)}`);
        if (pl.length) presetBlock = `\n【酒馆当前预设（以下是你所处剧本的世界观/语气/风格设定，务必遵守，不要违背、不要 OOC）】\n${pl.join('\n\n')}`;
    } catch (e) { /* 忽略 */ }
    const base = settings.promptTemplate
        .replaceAll('{char}', rater.name)
        .replaceAll('{user}', user)
        .replaceAll('{quote}', quote)
        .replaceAll('{extra}', extra ? `额外要求：${extra}` : '')
        .replaceAll('{extra_block}', extra ? `\n额外要求：${extra}` : '');
    const bgmReq = `\n\n【BGM 推荐】在你感想的最后另起一行，用固定格式给出一首与这段文字氛围最契合的现实中文歌曲：BGM:《歌名》-歌手名（歌名与歌手必须真实常见；这一行只写"歌名-歌手"，不要加任何解释或其他文字）。`;
    return `${persona ? persona + '\n' : ''}${awareness}${presentBlock}${presentPersonsBlock}${presetBlock}${recentBlock}${bgmReq}\n\n${base}`;

}

/** 自动探测角色英文 ID（纯英文名 / extensions.nickname / alternate_names） */
function detectEnglishId(ch) {
    if (!ch) return '';
    const name = String(ch.name || '');
    if (/^[A-Za-z0-9_\-\.\s]+$/.test(name)) return name.trim();
    const nick = ch.extensions && ch.extensions.nickname;
    if (typeof nick === 'string' && /^[A-Za-z0-9_\-\.\s]+$/.test(nick)) return nick.trim();
    const alt = ch.extensions && ch.extensions.alternate_names;
    if (Array.isArray(alt)) {
        const hit = alt.find((x) => typeof x === 'string' && /^[A-Za-z0-9_\-\.\s]+$/.test(x));
        if (hit) return hit.trim();
    }
    return '';
}

/** 角色 @ID：手动覆盖 > 自动英文 ID > 角色名 */
function charIdFor(name) {
    const s = getSettings();
    const manual = (s.charIdMap || {})[name];
    if (manual && manual.trim()) return manual.trim();
    const ch = findCharByName(name);
    const en = detectEnglishId(ch);
    return en || name;
}

/** 我的 @ID */
function userHandle() {
    const s = getSettings();
    if ((s.userId || '').trim()) return s.userId.trim();
    return (typeof name1 === 'string' && name1) ? name1 : '我';
}

async function generateRatings() {
    const settings = getSettings();
    const quoteInput = document.getElementById('dp-quote-input');
    const extraInput = document.getElementById('dp-extra-input');
    const generateBtn = document.getElementById('dp-btn-generate');
    if (!quoteInput || dp.busy) return;

    const quote = quoteInput.value.trim();
    if (!quote) {
        toast('warning', '请先选择/填写一段原文');
        return;
    }

    const ids = (dp.raterCharIds && dp.raterCharIds.length) ? dp.raterCharIds : [-1];
    const raters = ids.map((id) => resolveRater(String(id)));
    const extra = (extraInput.value || '').trim();
    const key = getTemplateKey(settings.activeTemplateId);

    dp.busy = true;
    const oldText = generateBtn.textContent;
    generateBtn.disabled = true;

    try {
        const created = [];
        for (let i = 0; i < raters.length; i++) {
            const rater = raters[i];
            generateBtn.textContent = `生成中 ${i + 1}/${raters.length}…`;
            const prompt = buildRaterPrompt(rater, quote, extra);
            let raw = '';
            if (apiConfigured()) {
                raw = await apiChatComplete([
                    { role: 'system', content: `你是「${rater.name}」，请始终以「${rater.name}」的身份、口吻和三观说话。` },
                    { role: 'user', content: prompt },
                ]);
            } else {
                try {
                    raw = await generateQuietPrompt({
                        quietPrompt: prompt,
                        quietToLoud: false,
                        forceChId: rater.index >= 0 ? rater.index : null,
                    });
                } catch (err) {
                    console.warn('[晋江段评] 带角色上下文失败，重试不带 forceChId', err);
                    raw = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false });
                }
            }
            // 检测到截断 → 自动续写一次，尽量补全
            raw = await ensureComplete(rater, prompt, raw);
            const cleaned = cleanRating(raw);
            if (!cleaned) continue;
            if (looksTruncated(raw)) {
                console.warn('[晋江段评] 输出疑似被截断', raw);
                toast('warning', `「${rater.name}」的段评可能仍被截断，建议调大模型输出上限后重试`);
            }
            // 解析 BGM 推荐行，并从正文剥离（正文不显示 BGM 行）
            let bgmTitle = '', bgmArtist = '';
            const bgmM = raw.match(/BGM\s*[:：]\s*[《"']?([^》"'\-\n|]+)[》"']?\s*[-—–|]\s*([^\n]+)/);
            if (bgmM) {
                bgmTitle = bgmM[1].trim();
                bgmArtist = bgmM[2].trim();
            }
            const cleanedNoBgm = cleaned.replace(/BGM\s*[:：].*$/mg, '').trim();
            const comment = {
                id: `c_${Date.now().toString(36)}_${i}_${Math.floor(Math.random() * 1e6).toString(36)}`,
                kind: 'char',
                authorName: rater.name,
                authorHandle: `@${charIdFor(rater.name)}`,
                avatarUrl: avatarUrlFor(rater.avatarFileName),
                timeText: commentTimeText(key, dp.comments.length),
                text: cleanedNoBgm || cleaned,
                bgmTitle,
                bgmArtist,
            };
            dp.comments.push(comment);
            created.push({ rater, text: cleaned });
        }
        // 自动追加 NPC 群评：读世界书全文，让模型让所有相关 NPC 各写一条
        try {
            const wb = await loadWorldbookContext();
            if (wb && wb.length > 50) {
                generateBtn.textContent = '生成 NPC 群评…';
                const npcPrompt = `你是一个段评生成器。以下是世界观/世界书设定：
${wb}

以下是一段剧情原文：
${quote}

请根据世界书设定，让其中与这段剧情相关的所有 NPC（非主角、非用户的角色）各写一条段评。每条格式严格为：
NPC名：评论内容
每行一条，NPC名用世界书里该角色的名字。评论要贴合该 NPC 的人设、性格、语气。不要写主角和用户自己的评论。不要加其他解释。`;
                let npcRaw = '';
                if (apiConfigured()) {
                    npcRaw = await apiChatComplete([
                        { role: 'system', content: '你是一个段评生成器，只输出NPC段评，每行一条，格式：NPC名：评论内容' },
                        { role: 'user', content: npcPrompt },
                    ]);
                } else {
                    npcRaw = await generateQuietPrompt({ quietPrompt: npcPrompt, quietToLoud: false });
                }
                const lines = npcRaw.split('\n');
                for (const line of lines) {
                    const m = line.match(/^\s*【?([^\s：:]{1,12})】?\s*[:：]\s*(.+)$/);
                    if (m && m[1] && m[2]) {
                        const nm = m[1].trim();
                        const tx = m[2].trim();
                        if (nm && tx && !/^(BGM|备注|解释|以下|以上)/.test(nm)) {
                            dp.comments.push({
                                id: `c_npc_${Date.now().toString(36)}_${Math.floor(Math.random()*1e6).toString(36)}`,
                                kind: 'char',
                                authorName: nm,
                                authorHandle: `@${charIdFor(nm)}`,
                                avatarUrl: null,
                                timeText: commentTimeText(key, dp.comments.length),
                                text: tx,
                                bgmTitle: '',
                                bgmArtist: '',
                            });
                        }
                    }
                }
            }
        } catch (e) { console.warn('[晋江段评] NPC群评失败', e); }        await renderCommentList();
        await renderCard();
        if (created.length) {
            toast('success', `已生成 ${created.length} 条段评`);
        } else {
            toast('warning', '没有生成出内容，请重试');
        }
    } catch (err) {
        console.error('[晋江段评] 生成失败', err);
        toast('error', `生成失败：${err?.message || err}`);
    } finally {
        dp.busy = false;
        generateBtn.disabled = false;
        generateBtn.textContent = oldText;
    }
}

/** 生成结果疑似截断时自动续写一次（API / 酒馆模式均支持） */
async function ensureComplete(rater, prompt, raw) {
    if (!looksTruncated(raw)) return raw;
    try {
        const tail = String(raw || '').replace(/[\s"'”』】）》]+$/, '');
        if (!tail) return raw;
        let cont = '';
        if (apiConfigured()) {
            cont = await apiChatComplete([
                { role: 'system', content: `你是「${rater.name}」，请始终以「${rater.name}」的身份、口吻和三观说话。` },
                { role: 'user', content: prompt },
                { role: 'assistant', content: tail },
                { role: 'user', content: '上一条消息被截断了，请直接从断处接着写完结尾，不要重复已写内容，不要解释。' },
            ]);
        } else {
            cont = await generateQuietPrompt({
                quietPrompt: `【续写】下面这条消息被截断了，请直接从结尾处接着写完（不要重复前面内容，不要解释）。\n被截断的消息：\n${tail}\n\n续写：`,
                quietToLoud: false,
                forceChId: rater.index >= 0 ? rater.index : null,
            });
        }
        cont = cleanRating(cont).replace(/^(继续|好的|好的，|没问题|没问题，|接着|然后)/, '').trim();
        if (cont) {
            return tail.replace(/[,，;；:：—]+$/, '') + cont;
        }
    } catch (err) {
        console.warn('[晋江段评] 自动续写失败', err);
    }
    return raw;
}

// =====================================================================
// 评论列表（面板内编辑） / 用户评论
// =====================================================================

function userAvatarUrl() {
    if (user_avatar) {
        return `${location.origin}/User Avatars/${encodeURIComponent(user_avatar)}`;
    }
    return null;
}

function addUserComment() {
    const input = document.getElementById('dp-user-comment-input');
    if (!input) return;
    const text = (input.value || '').trim();
    if (!text) {
        toast('warning', '先写下你的评论吧');
        return;
    }
    const key = getTemplateKey(getSettings().activeTemplateId);
    const me = (typeof name1 === 'string' && name1) ? name1 : '我';
    dp.comments.push({
        id: `u_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        kind: 'user',
        authorName: me,
        authorHandle: `@${userHandle()}`,
        avatarUrl: userAvatarUrl(),
        timeText: commentTimeText(key, 0),
        text,
    });
    input.value = '';
    renderCommentList();
    renderCard();
    toast('success', '已添加你的评论');
}

function renderCommentList() {
    const box = document.getElementById('dp-comment-list');
    if (!box) return;
    if (!dp.comments || !dp.comments.length) {
        box.innerHTML = '<div class="dp-comment-empty">还没有评论 —— 点「⚡ 调取 App 生成段评」，或在上方写一条自己的评论</div>';
        return;
    }
    box.innerHTML = dp.comments.map((c) => `
      <div class="dp-comment-row" data-id="${esc(c.id)}">
        <div class="dp-comment-head">
          <span class="dp-comment-tag ${c.kind === 'user' ? 'dp-tag-user' : 'dp-tag-char'}">${c.kind === 'user' ? '我' : '角色'}</span>
          <span class="dp-comment-author">${esc(c.authorName)}</span>
          <span class="dp-comment-ctime">${esc(c.timeText)}</span>
          <button type="button" class="dp-btn dp-btn-sm dp-btn-danger dp-comment-del">删除</button>
        </div>
        <textarea class="dp-comment-text-input" rows="2" data-id="${esc(c.id)}">${esc(c.text)}</textarea>
      </div>`).join('');

    box.querySelectorAll('.dp-comment-del').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.closest('.dp-comment-row').dataset.id;
            dp.comments = dp.comments.filter((x) => x.id !== id);
            renderCommentList();
            renderCard();
        });
    });
    box.querySelectorAll('.dp-comment-text-input').forEach((ta) => {
        ta.addEventListener('input', debounce(() => {
            const c = dp.comments.find((x) => x.id === ta.dataset.id);
            if (c) {
                c.text = ta.value;
                renderCard();
            }
        }, 350));
    });
}

// =====================================================================
// 图片下载
// =====================================================================

function ensureHtml2canvas(frame) {
    return new Promise((resolve, reject) => {
        const win = frame.contentWindow;
        if (win.html2canvas) return resolve(win.html2canvas);
        const settings = getSettings();
        const candidates = [
            settings.html2canvasUrl,
            'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js',
            'https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
            'https://cdn.bootcdn.net/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
        ].filter(Boolean);

        let done = false;
        const fail = () => {
            if (done) return;
            done = true;
            reject(new Error('无法加载 html2canvas（网络不可用？）'));
        };
        const ok = () => {
            if (done) return;
            done = true;
            resolve(win.html2canvas);
        };
        const tryLoad = (i) => {
            if (i >= candidates.length) return fail();
            const s = win.document.createElement('script');
            s.src = candidates[i];
            s.onload = () => (win.html2canvas ? ok() : tryLoad(i + 1));
            s.onerror = () => tryLoad(i + 1);
            win.document.head.appendChild(s);
            setTimeout(() => {
                if (!done) {
                    if (win.html2canvas) ok();
                    else if (i < candidates.length - 1) tryLoad(i + 1);
                    else fail();
                }
            }, 10000);
        };
        tryLoad(0);
    });
}

function materializePseudo(srcEl, dstEl, srcDoc, pseudo) {
    try {
        const cs = srcDoc.defaultView.getComputedStyle(srcEl, pseudo);
        const content = cs.content;
        if (!content || content === 'none' || content === 'normal' || content === '') return;
        const span = srcDoc.createElement('span');
        span.setAttribute('style', cs.cssText);
        if (content.startsWith('url(')) {
            const url = content.slice(4, -1).replace(/['"]/g, '');
            span.style.backgroundImage = `url(${url})`;
            span.style.backgroundRepeat = 'no-repeat';
            span.style.backgroundPosition = 'center';
        } else if (content !== '""' && content !== '') {
            span.textContent = content.replace(/^["']|["']$/g, '');
        }
        dstEl.appendChild(span);
    } catch { /* 忽略单个伪元素 */ }
}

function absolutizeCssUrl(cssText, origin) {
    return String(cssText).replace(/url\((["']?)([^"')]+)\1\)/g, (m, q, url) => {
        if (/^(data:|https?:|blob:)/.test(url)) return m;
        return `url(${q}${origin}/${url.replace(/^\/+/, '')}${q})`;
    });
}

function inlineComputedStyles(srcDoc, srcRoot, dstRoot) {
    const srcEls = srcRoot.querySelectorAll('*');
    const dstEls = dstRoot.querySelectorAll('*');
    for (let i = 0; i < srcEls.length && i < dstEls.length; i++) {
        const cs = srcDoc.defaultView.getComputedStyle(srcEls[i]);
        dstEls[i].setAttribute('style', absolutizeCssUrl(cs.cssText, location.origin));
        materializePseudo(srcEls[i], dstEls[i], srcDoc, '::before');
        materializePseudo(srcEls[i], dstEls[i], srcDoc, '::after');
    }
    const csRoot = srcDoc.defaultView.getComputedStyle(srcRoot);
    dstRoot.setAttribute('style', absolutizeCssUrl(csRoot.cssText, location.origin));
    materializePseudo(srcRoot, dstRoot, srcDoc, '::before');
    materializePseudo(srcRoot, dstRoot, srcDoc, '::after');
}

/** 取整卡容器（正文卡片 + 评论模块） */
function getCardWrap(frame) {
    const doc = frame.contentDocument;
    return (doc && (doc.querySelector('.dp-card-wrap') || doc.querySelector('.be-card'))) || null;
}

/** SVG foreignObject 兜底截图（无外部依赖） */
/** SVG 下载用：把字体分片全部转 base64 内联（SVG 的 img 不加载外部字体，否则下载图字体回退默认） */
async function buildSvgFontCss() {
    try {
        const st = getSettings();
        if (!st.fontCssKey) return '';
        let cssText = '';
        if (st.fontCssKey.indexOf('link:') === 0) {
            const r = await fetch(st.fontCssKey.slice(5));
            if (!r.ok) return '';
            cssText = await r.text();
        } else {
            cssText = (await idbGet(st.fontCssKey)) || '';
        }
        if (!cssText) return '';
        const faces = cssText.match(/@font-face\s*\{([^}]+)\}/g) || [];
        if (!faces.length) return '';
        const rebuilt = await Promise.all(faces.map(async (face) => {
            const mUrl = face.match(/url\(\s*["']?([^"')]+)["']?\s*\)/);
            if (mUrl && /^https?:/i.test(mUrl[1])) {
                try {
                    const resp = await fetch(mUrl[1], { signal: AbortSignal.timeout(5000) });
                    if (resp.ok) {
                        const b64 = await blobToDataURL(await resp.blob());
                        return face.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/, 'url("' + b64 + '")');
                    }
                } catch (e) { /* 该分片保留原 url（SVG 内不加载，该字符回退） */ }
            }
            return face;
        }));
        return '<style>' + rebuilt.join('\n') + '</style>';
    } catch (e) { return ''; }
}

async function captureWithSvg(frame) {
    const doc = frame.contentDocument;
    const card = getCardWrap(frame);
    if (!card) throw new Error('未找到卡片');

    const w = card.scrollWidth;
    const h = card.scrollHeight;
    const scale = Math.min(4, 4096 / Math.max(w, h) || 4);

    // 拍平渲染易碎属性（阴影/描边/滤镜），确保标题等文字在 foreignObject 里稳定画出
    const dlFlatten = injectDlFlatten(frame);
    let cloned;
    try {
        cloned = card.cloneNode(true);
        inlineComputedStyles(doc, card, cloned);
        // 强制内联纸张材质到每个纸片（确保 SVG foreignObject 渲染完整纹理，不依赖类样式/原内联）
        try {
            const wl = cloned.querySelectorAll('.dp-collage-word');
            for (const w of wl) {
                const pm = (w.className || '').match(/dp-paper-(\w+)/);
                const pp = pm ? pm[1] : 'plain';
                if (pp === 'custom') { const cpi = getSettings().collagePaperImg; if (cpi) { w.style.backgroundImage = `url('${cpi}')`; w.style.backgroundSize = '100% 100%'; } } else if (PAPER_IMG[pp]) { w.style.backgroundImage = PAPER_IMG[pp]; w.style.backgroundSize = pp === 'xuan' ? '6px 6px' : '100% 100%'; }
            }
        } catch { /* ignore */ }
        // SVG 是 XML 文档，而 HTML 序列化不会转义文本节点里的 < > &（chat 正文常见），
        // 不转义会导致 <foreignObject> 内容 XML 解析失败、img 加载失败 → 把文本节点 XML 转义
        const walker = doc.createTreeWalker(cloned, 4 /* NodeFilter.SHOW_TEXT */);
        const txtNodes = [];
        while (walker.nextNode()) txtNodes.push(walker.currentNode);
        for (const tn of txtNodes) {
            tn.textContent = String(tn.textContent)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }
    } finally {
        if (dlFlatten && dlFlatten.parentNode) dlFlatten.remove();
    }

    const bodyInner = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;transform:scale(${scale});transform-origin:0 0;">${await buildSvgFontCss()}${cloned.outerHTML}</div>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * scale}" height="${h * scale}"><foreignObject width="100%" height="100%">${bodyInner}</foreignObject></svg>`;

    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
        const img = new frame.contentWindow.Image();
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('SVG 渲染失败'));
            img.src = url;
        });
        const canvas = doc.createElement('canvas');
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas;
    } finally {
        URL.revokeObjectURL(url);
    }
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/**
 * 下载专用样式：把水印标题/欢迎语的阴影、描边、滤镜、填充色拍平为浏览器可稳定渲染的基础样式。
 * html2canvas / SVG foreignObject 两条渲染管线对 text-shadow / -webkit-text-stroke / filter 的
 * 支持不稳定（可能整块文字渲染为空），拍平后确保「小狗日记」标题在任何管线都能画出。
 * 只动渲染易碎属性，不动 position/transform/布局，下载结果与预览视觉一致。
 */
function injectDlFlatten(frame) {
    const doc = frame.contentDocument;
    let st = doc.getElementById('dp-dl-flatten');
    if (!st) {
        st = doc.createElement('style');
        st.id = 'dp-dl-flatten';
        doc.head.appendChild(st);
    }
    st.textContent = [
        '.dp-card-wrap .be-watermark .be-wm-title,',
        '.dp-card-wrap .be-watermark .be-wm-sub {',
        '  text-shadow: none !important;',
        '  -webkit-text-stroke: 0 !important;',
        '  -webkit-text-fill-color: inherit !important;',
        '  filter: none !important;',
        '  opacity: 1 !important;',
        '}',
    ].join('\n');
    return st;
}

async function downloadCardImage() {
    // 拼贴模式优先：以原图分辨率离屏重绘（与预览同一套 drawCollageWord 逻辑），导出与预览 100% 一致的 PNG
    try {
        const s0 = getSettings();
        const words0 = s0.collageWords || [];
        const cc0 = document.getElementById('dp-collage-canvas');
        if (cc0 && words0.length > 0) {
            const sz0 = collageImgSize();
            const W0 = sz0 ? sz0.W : 1080;
            const H0 = sz0 ? sz0.H : 1470;
            const off0 = document.createElement('canvas');
            off0.width = W0;
            off0.height = H0;
            const octx0 = off0.getContext('2d');
            const img0 = await collageEnsureImage();
            if (img0) octx0.drawImage(img0.img, 0, 0, W0, H0);
            else { octx0.fillStyle = s0.collageBgColor || '#000000'; octx0.fillRect(0, 0, W0, H0); }
            await collageLoadAllFonts();
            const famStr0 = String(s0.fontFamily || 'dp-font-custom').replace(/["']/g, '');
            if (famStr0 && document.fonts && document.fonts.load) {
                try { await Promise.race([Promise.all([document.fonts.load(`16px "${famStr0}"`), document.fonts.load(`32px "${famStr0}"`)]), new Promise((res) => setTimeout(res, 1500))]); } catch (e) { /* noop */ }
            }
            const oldScale = collageState.scale;
            collageState.scale = 1;
            try { for (const w of words0) drawCollageWord(octx0, w); } finally { collageState.scale = oldScale; }
            const blob0 = await new Promise((res) => off0.toBlob(res, 'image/png'));
            if (blob0) {
                const a0 = document.createElement('a');
                a0.href = URL.createObjectURL(blob0);
                a0.download = `段评_${timestamp()}.png`;
                document.body.appendChild(a0);
                a0.click();
                setTimeout(() => { URL.revokeObjectURL(a0.href); a0.remove(); }, 1000);
                toast('success', '段评图片已下载（与预览一致）');
                return;
            }
        }
    } catch (e) { /* 回退原链路 */ }
    const frame = document.getElementById('dp-frame');
    if (!frame || !frame.contentDocument) {
        toast('warning', '请先生成段评卡片');
        return;
    }
    const card = getCardWrap(frame);
    if (!card) {
        toast('warning', '请先生成段评卡片');
        return;
    }
    const settings = getSettings();
    const engine = settings.captureEngine || 'auto';
    const filename = `段评_${timestamp()}.png`;

    // 背景图若为 http 链接：下载前先转 base64 注入卡片（跨域链接 html2canvas 画不出），
    // 保证下载图与预览完全一致；本地上传（已是 base64）直接跳过
    if (settings.bgImage && settings.bgImage.indexOf('http') === 0) {
        try {
            const resp = await fetch(settings.bgImage);
            const blob = await resp.blob();
            settings.bgImage = await new Promise((res) => {
                const rd = new FileReader();
                rd.onload = () => res(String(rd.result));
                rd.readAsDataURL(blob);
            });
            saveSettingsDebounced();
            renderCard();
        } catch (e) {
            toast('warning', '背景图跨域，下载可能无背景；建议改用本地上传');
        }
    }

    // 手机端预览会等比缩放卡片（transform:scale），下载前临时移除，保证输出原始分辨率
    const hadScale = !!card.style.transform;
    if (hadScale) card.style.transform = '';
    const hasPaper = !!card.querySelector('.dp-collage-word');
    const dlFlatten = injectDlFlatten(frame);
    try {
    // 材质纸片下载兼容：html2canvas 不支持 repeating/radial 纹理，下载前注入单层渐变内联（仅 html2canvas 分支；拼贴纸片走 SVG 保留完整纹理）
    const paperDl = { kraft: 'linear-gradient(160deg, rgba(190,150,90,.42), rgba(160,120,70,.2) 50%, rgba(130,95,55,.38))', craft: 'linear-gradient(160deg, rgba(165,110,55,.46), rgba(125,80,38,.24) 55%, rgba(100,62,28,.4))', xuan: 'linear-gradient(160deg, rgba(160,130,90,.24), rgba(140,110,70,.1))', news: 'linear-gradient(0deg, rgba(80,80,80,.18), rgba(80,80,80,.08))', lined: 'linear-gradient(0deg, rgba(90,140,220,.34), rgba(90,140,220,.12))', grid: 'linear-gradient(0deg, rgba(90,140,220,.3), rgba(90,140,220,.1))', torn: '' };
    try { if (!hasPaper && frame.contentDocument) frame.contentDocument.querySelectorAll('.dp-collage-word').forEach((w) => { const m = (w.className || '').match(/dp-paper-(\w+)/); if (m && paperDl[m[1]] !== undefined) w.style.backgroundImage = paperDl[m[1]]; }); } catch { /* ignore */ }
        // 等待 iframe 内字体加载完成：小票 woff 字体未就绪时 html2canvas 会用回退字体渲染，
        // 表现为文字发糊/变样；fonts.ready 可确保按模板字体渲染
        // 下载前强制加载字体全部分片（unicode-range 按需加载，仅 fonts.ready 会让下载图缺字用默认字体）
        try {
            const fam2 = settings.fontFamily || 'dp-font-custom';
            const chars = new Set();
            frame.contentDocument.querySelectorAll('.dp-collage-word span, .be-card').forEach((el) => { String(el.textContent || '').split('').forEach((c) => chars.add(c)); });
            if (frame.contentDocument.fonts && chars.size) await Promise.all([...chars].map((c) => frame.contentDocument.fonts.load('28px "' + fam2 + '"', c).catch(() => null)));
        } catch { /* ignore */ }
        try { if (frame.contentDocument.fonts && frame.contentDocument.fonts.ready) await frame.contentDocument.fonts.ready; } catch { /* ignore */ }
        // 拼贴纸片（材质纹理）一律走 SVG：浏览器渲染完整支持 repeating/radial 纹理 + base64 字体
        if (engine !== 'svg' && !hasPaper) {
            try {
                await ensureHtml2canvas(frame);
                try { if (frame.contentDocument.fonts && frame.contentDocument.fonts.ready) await frame.contentDocument.fonts.ready; } catch { /* ignore */ }
                const canvas = await frame.contentWindow.html2canvas(card, {
                    scale: 6,
                    useCORS: true,
                    backgroundColor: null,
                    width: card.scrollWidth,
                    height: card.scrollHeight,
                    windowWidth: card.scrollWidth,
                    logging: false,
                });
                const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
                if (blob) {
                    downloadBlob(blob, filename);
                    // 下载后恢复材质纹理：仅移除下载注入的内联渐变（回 CSS 类纹理），不重建 DOM，保证纸片位置不变
                    try { if (frame.contentDocument) frame.contentDocument.querySelectorAll('.dp-collage-word').forEach((w) => { const pm = (w.className || '').match(/dp-paper-(\w+)/); w.style.backgroundImage = (pm && PAPER_IMG[pm[1]]) || ''; w.style.backgroundSize = pm && pm[1] === 'xuan' ? '6px 6px' : '100% 100%'; }); } catch { /* ignore */ }
                    toast('success', '段评图片已下载');
                    return;
                }
                throw new Error('canvas 为空');
            } catch (err) {
                if (engine === 'html2canvas') {
                    console.error('[晋江段评] html2canvas 失败', err);
                    toast('error', `图片生成失败：${err?.message || err}`);
                    return;
                }
                console.warn('[晋江段评] html2canvas 失败，改用 SVG 兜底', err);
            }
        }

        try {
            try { if (frame.contentDocument.fonts && frame.contentDocument.fonts.ready) await frame.contentDocument.fonts.ready; } catch { /* ignore */ }
            const canvas = await captureWithSvg(frame);
            const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
            if (blob) {
                downloadBlob(blob, filename);
                // 下载后恢复材质纹理：仅移除下载注入的内联渐变（回 CSS 类纹理），不重建 DOM，保证纸片位置不变
                try { if (frame.contentDocument) frame.contentDocument.querySelectorAll('.dp-collage-word').forEach((w) => { w.style.backgroundImage = ''; }); } catch { /* ignore */ }
                toast('success', '段评图片已下载（SVG 模式）');
            }
        } catch (err) {
            console.error('[晋江段评] SVG 兜底失败', err);
            // SVG 渲染失败（大图/安全策略）时自动退回 html2canvas，保证至少能下载（材质为单层渐变近似）
            try {
                await ensureHtml2canvas(frame);
                try { if (frame.contentDocument) frame.contentDocument.querySelectorAll('.dp-collage-word').forEach((w) => { const m = (w.className || '').match(/dp-paper-(\w+)/); if (m && paperDl[m[1]] !== undefined) w.style.backgroundImage = paperDl[m[1]]; }); } catch { /* ignore */ }
                try { if (frame.contentDocument.fonts && frame.contentDocument.fonts.ready) await frame.contentDocument.fonts.ready; } catch { /* ignore */ }
                const canvas2 = await frame.contentWindow.html2canvas(card, { scale: 6, useCORS: true, backgroundColor: null, width: card.scrollWidth, height: card.scrollHeight, windowWidth: card.scrollWidth, logging: false });
                const blob2 = await new Promise((res) => canvas2.toBlob(res, 'image/png'));
                if (blob2) { downloadBlob(blob2, filename); toast('warning', 'SVG 渲染受限，已用兼容模式下载'); return; }
            } catch (e2) { /* fallthrough */ }
            const msg = /tainted|SecurityError|跨域/i.test(String(err?.message || err))
                ? 'SVG 渲染被浏览器安全策略拦截，请将「图片引擎」切换为 html2canvas 后重试'
                : `图片生成失败：${err?.message || err}`;
            toast('error', msg);
        }
    } finally {
        if (hadScale) card.style.transform = `scale(${frame._scaleRatio || 1})`;
        if (dlFlatten && dlFlatten.parentNode) dlFlatten.remove();
    }
}

// =====================================================================
// 文本选择 → 浮动按钮
// =====================================================================

function getSelectionContext(sel) {
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    if (!text) return null;
    const node = sel.anchorNode;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const mes = el && el.closest ? el.closest('.mes') : null;
    if (!mes) return null;
    if (mes.closest('#dp-modal') || mes.closest('#dp-tpl-modal')) return null;

    const mesId = mes.dataset?.mesid ?? mes.getAttribute('mesid') ?? null;
    let index = -1;
    if (mesId !== null && mesId !== undefined) {
        index = chat.findIndex((m) => String(m.mesId) === String(mesId));
    }
    if (index < 0) {
        index = Array.from(document.querySelectorAll('#chat .mes')).indexOf(mes);
    }
    const author = index >= 0 && chat[index] ? chat[index].name : '';
    return { text, mesIndex: Math.max(0, index), author };
}

function showFloatButton(rect) {
    const btn = document.getElementById('dp-float-btn');
    if (!btn) return;
    const w = btn.offsetWidth || 86;
    const h = btn.offsetHeight || 40;
    const isMobile = window.innerWidth < 768;
    let left, top;
    if (isMobile) {
        // 手机端：放选区上方，上方放不下放下方
        left = rect.left + rect.width / 2 - w / 2;
        top = rect.top - h - 10;
        if (top < 8) top = rect.bottom + 10;
    } else {
        // 电脑端：放选区右侧，右侧放不下放左侧
        left = rect.right + 10;
        top = rect.top + rect.height / 2 - h / 2;
        if (left + w > window.innerWidth - 8) left = rect.left - w - 10;
    }
    left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
    top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
    btn.style.left = left + 'px';
    btn.style.top = top + 'px';
    btn.style.display = 'flex';
}

function hideFloatButton() {
    const btn = document.getElementById('dp-float-btn');
    if (btn) btn.style.display = 'none';
}

function onSelectionChange() {
    const sel = window.getSelection();
    const context = getSelectionContext(sel);
    if (!context) {
        hideFloatButton();
        return;
    }
    try {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        if (rect.width < 2 && rect.height < 2) {
            hideFloatButton();
            return;
        }
        showFloatButton(rect);
    } catch {
        hideFloatButton();
        return;
    }
    dp.selection = context;
}

// =====================================================================
// 面板 UI
// =====================================================================

function injectShell() {
    if (document.getElementById('dp-modal')) return;

    // 注入样式表
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${extensionFolderPath}/style.css`;
    document.head.appendChild(link);

    const shell = document.createElement('div');
    shell.innerHTML = `
<div id="dp-float-btn" style="display:none;" title="给这段文字写段评">
  <span class="dp-fb-icon">✎</span>
  <span class="dp-fb-label">段评</span>
</div>

<div id="dp-launcher" title="打开晋江段评面板">
  <span class="dp-launcher-icon">✎</span>
  <span class="dp-launcher-label">段评</span>
</div>

<div id="dp-modal" class="dp-modal-mask" style="display:none;">
  <div class="dp-modal-panel">
    <div class="dp-modal-head">
      <div class="dp-modal-title">✎ 段评 <span class="dp-sub">晋江文学城风</span></div>
      <div class="dp-head-actions">
        <button type="button" id="dp-btn-advanced" class="dp-btn dp-btn-sm">设置</button>
        <button type="button" class="dp-btn dp-btn-ghost dp-close" data-close="dp-modal">✕</button>
      </div>
    </div>

    <div class="dp-body">
      <div class="dp-field">
        <label>选中段落 <span class="dp-hint">（可编辑）</span></label>
        <textarea id="dp-quote-input" rows="3" placeholder="长按/拖选聊天中的文本，或直接粘贴一段原文…"></textarea>
      </div>

      <div class="dp-row">
        <div class="dp-field dp-grow">
          <label>评价角色 <span class="dp-hint">（可多选）</span></label>
          <div id="dp-char-list" class="dp-char-list"></div>
        </div>
        <div class="dp-field dp-grow">
          <label>额外要求 <span class="dp-hint">（可选）</span></label>
          <input id="dp-extra-input" type="text" placeholder="例：毒舌一点 / 打五星 / 用方言">
        </div>
      </div>

      <div class="dp-api-box">
        <div class="dp-row dp-row-center" style="margin-bottom:8px;">
          <label class="dp-check"><input id="dp-api-enable" type="checkbox"><span>使用自填 API 调取模型</span></label>
          <span class="dp-hint">开启后生成走自填 API，不走酒馆 App</span>
          <button type="button" id="dp-api-test" class="dp-btn dp-btn-sm">测试连接</button>
        </div>
        <div class="dp-row" style="margin-bottom:8px;">
          <input id="dp-api-url" type="text" class="dp-grow" placeholder="API 地址（含端口），如 http://127.0.0.1:11434/v1 或 https://api.openai.com/v1">
          <input id="dp-api-key" type="password" placeholder="API Key（可选）">
        </div>
        <div class="dp-row" style="margin-bottom:0;">
          <select id="dp-api-model" class="dp-grow"><option value="">选择模型…</option></select>
          <button type="button" id="dp-api-models" class="dp-btn dp-btn-sm">刷新模型列表</button>
        </div>
      </div>

      <div class="dp-row dp-row-center">
        <button type="button" id="dp-btn-generate" class="dp-btn dp-btn-primary">⚡ 调取 App 生成段评</button>
      </div>

      <div class="dp-field">
        <label>我的评论 <span class="dp-hint">（选填，用你的面具头像）</span></label>
        <div class="dp-row">
          <input id="dp-user-comment-input" type="text" class="dp-grow" placeholder="以你的身份评论这条段评…">
          <button type="button" id="dp-btn-add-user-comment" class="dp-btn">➕ 确认添加</button>
        </div>
      </div>

      <div class="dp-field">
        <label>评论列表 <span class="dp-hint">（角色段评 + 你的评论，可编辑/删除）</span></label>
        <div id="dp-comment-list" class="dp-comment-list"></div>
      </div>

      

      <div class="dp-row">
        <div class="dp-field dp-grow">
          <label>CSS 模板</label>
          <select id="dp-tpl-select"></select>
        </div>
        <div class="dp-field">
          <label>&nbsp;</label>
          <div class="dp-btn-group">
            <button type="button" id="dp-btn-manage-tpl" class="dp-btn">管理模板</button>
          </div>
        </div>
      </div>

      <div class="dp-preview-wrap">
        <div class="dp-preview-head">
          <label>卡片预览</label>
          <div class="dp-preview-tools">
            <div class="dp-width-ctl">
              <span class="dp-width-tag">宽度</span>
              <input type="range" id="dp-width-slider" min="0" max="720" step="10" value="0" title="0 = 跟随模板宽度">
              <span id="dp-width-val" class="dp-width-val">跟随模板</span>
            </div>
            <button type="button" id="dp-btn-sticker" class="dp-btn dp-btn-sm">贴纸</button>
            <button type="button" id="dp-btn-brush" class="dp-btn dp-btn-sm">画笔</button>
            <button type="button" id="dp-btn-mosaic" class="dp-btn dp-btn-sm">马赛克</button>
            <button type="button" id="dp-btn-collage-main" class="dp-btn dp-btn-sm">拼贴诗</button>
            <button type="button" id="dp-btn-night" class="dp-btn dp-btn-sm">夜间</button>
          </div>
        </div>
        <div class="dp-frame-box">
          <iframe id="dp-frame" style="width:460px;height:300px;"></iframe>
        </div>
        <div id="dp-collage-bar" class="dp-collage-bar" style="display:none">
          <div class="dp-cb-row">
            <input id="dp-cb-input" type="text" maxlength="30" placeholder="输入一个字/词，回车添加">
            <button type="button" id="dp-cb-add" class="dp-btn dp-btn-primary dp-btn-sm">＋ 添加</button>
            <button type="button" id="dp-cb-import" class="dp-btn dp-btn-sm" title="从主面板选中段落按词导入">导入段落</button>
            <button type="button" id="dp-cb-del" class="dp-btn dp-btn-sm dp-btn-danger">删选中</button>
            <button type="button" id="dp-cb-clear" class="dp-btn dp-btn-sm dp-btn-danger">清空</button>
            <button type="button" id="dp-cb-close" class="dp-btn dp-btn-sm">✓ 完成</button>
          </div>
          <div class="dp-cb-row">
            <label>形状<select id="dp-cb-shape"><option value="round" selected>圆角</option><option value="rect">矩形</option><option value="circle">圆形</option><option value="ellipse">椭圆</option></select></label>
            <label>纸张<select id="dp-cb-paper"><option value="none" selected>透明</option><option value="custom">上传材质</option><option value="kraft">牛皮纸</option><option value="craft">手工纸</option><option value="xuan">宣纸</option><option value="news">报纸</option><option value="lined">横线纸</option><option value="grid">方格纸</option></select><input type="file" id="dp-paper-upload" accept="image/*" style="display:none"></label><label>调色<input type="color" id="dp-cb-tint" value="#8b5a2b" style="width:30px;height:26px;padding:0;border:none;background:none"><input type="range" id="dp-cb-tint-s" min="0" max="100" value="0" style="width:56px;vertical-align:middle"></label>
            <label>纸色<input id="dp-cb-bg" type="color" value="#f5eedd"></label>
            <label>字色<input id="dp-cb-fg" type="color" value="#333333"></label>
            <label>字号<input id="dp-cb-size" type="number" min="10" max="200" step="1" value="36"></label>
            <label>宽<input id="dp-cb-w" type="number" min="20" max="1000" step="1" value="120"></label>
            <label>高<input id="dp-cb-h" type="number" min="20" max="1000" step="1" value="80"></label>
            <label>旋转°<input id="dp-cb-rot" type="number" min="-180" max="180" step="1" value="0"></label>
            <span class="dp-cb-hint">在预览上点纸片可选中拖动，先点纸片再调参数</span>
          </div>
        </div>
<div id="dp-brush-bar" class="dp-collage-bar" style="display:none">
          <div class="dp-cb-row">
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="pencil">铅笔</button>
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="pen">钢笔</button>
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="crayon">蜡笔</button>
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="marker">马克笔</button>
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="water">水彩笔</button>
            <button type="button" class="dp-brush-t dp-btn dp-btn-sm" data-t="eraser">橡皮</button>
            <label style="font-size:12px;color:#666;">粗细<input type="range" id="dp-brush-size" min="1" max="40" value="3" style="width:70px;vertical-align:middle;"></label>
          </div>
          <div class="dp-cb-row">
            <div id="dp-brush-colors" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;"></div>
            <input type="color" id="dp-brush-color" value="#1a1a1a" title="自定义颜色" style="width:32px;height:28px;border:1px solid #ddd;border-radius:6px;cursor:pointer;padding:0;">
            <button type="button" id="dp-brush-clear" class="dp-btn dp-btn-sm dp-btn-danger">清除</button>
            <button type="button" id="dp-brush-done" class="dp-btn dp-btn-sm">✓ 完成</button>
          </div>
        </div>
        <div id="dp-mosaic-bar" class="dp-collage-bar" style="display:none">
          <div class="dp-cb-row">
            <button type="button" class="dp-mosaic-t dp-btn dp-btn-sm" data-m="blocks">方块</button>
            <button type="button" class="dp-mosaic-t dp-btn dp-btn-sm" data-m="pixel">像素</button>
            <button type="button" class="dp-mosaic-t dp-btn dp-btn-sm" data-m="blur">模糊</button>
            <button type="button" class="dp-mosaic-t dp-btn dp-btn-sm" data-m="solid">纯色</button>
            <span>粗细：<input type="range" id="dp-mosaic-size" min="4" max="50" value="14" style="width:80px;vertical-align:middle"></span>
            <button type="button" id="dp-mosaic-clear" class="dp-btn dp-btn-sm dp-btn-danger">清空</button>
            <button type="button" id="dp-mosaic-done" class="dp-btn dp-btn-sm">✓ 完成</button>
          </div>
        </div>
        <div class="dp-collage-pick" id="dp-collage-pick" style="display:none">
              <div class="dp-pick-bar">
                <span class="dp-pick-title">涂抹选取文本 · 点击字/词即贴到预览卡片（和表情包一样）</span>
                <button type="button" id="dp-pick-close" class="dp-btn dp-btn-sm">收起</button>
              </div>
              <div class="dp-pick-modes">
                <button type="button" id="dp-pick-mode-word" class="dp-pick-mode on">按词</button>
                <button type="button" id="dp-pick-mode-char" class="dp-pick-mode">逐字</button>
                <button type="button" id="dp-pick-mode-free" class="dp-pick-mode">选段</button>
                <span class="dp-pick-hint">已选 <b id="dp-pick-count">0</b> 个 · 选段=在原文上任意圈选几个字</span>
              </div>
              <div class="dp-pick-source" id="dp-pick-source" style="display:none">
                <div class="dp-pick-source-text" id="dp-pick-source-text"></div>
                <div class="dp-pick-source-ops">
                  <button type="button" id="dp-pick-addsel" class="dp-btn dp-btn-sm">＋ 添加选中</button>
                  <button type="button" id="dp-pick-import" class="dp-btn dp-btn-primary dp-btn-sm">✓ 导入已选</button>
                  <span class="dp-pick-source-hint">用鼠标/手指在原文上圈选一段文字，再点「添加选中」；可多次圈选</span>
                </div>
              </div>
              <div class="dp-pick-list" id="dp-pick-list"></div>
            </div>

      </div>

      <div class="dp-advanced">
        <div class="dp-sec-title">设置</div>
        <div class="dp-row">
          <div class="dp-field"><label>书名</label><input id="dp-set-title" type="text" placeholder="留空显示《晋江文学城》"></div>
          <div class="dp-field"><label>章节</label><input id="dp-set-chapter" type="text" placeholder="留空自动 = 第N条"></div>
        </div>
        <div class="dp-row">
          <div class="dp-field"><label>水印文字</label><input id="dp-set-watermark" type="text" placeholder="留空 = 段评 · 角色名"></div>
          <div class="dp-field"><label>引用字号</label><input id="dp-set-qsize" type="number" min="10" max="30" step="1"></div>
          <div class="dp-field"><label>行高</label><input id="dp-set-qlh" type="number" min="1" max="2.5" step="0.1"></div>
          <div class="dp-field"><label>字距（em）</label><input id="dp-set-qls" type="number" min="-1" max="5" step="0.5" placeholder="0=默认"></div>
        </div>
        <div class="dp-row">
          <div class="dp-field dp-grow">
            <label>评价提示词模板 <span class="dp-hint">{char} {user} {quote} {extra}</span></label>
            <textarea id="dp-set-prompt" rows="4" spellcheck="false"></textarea>
          </div>
        </div>
        <div class="dp-row">
          <div class="dp-field"><label>图片宽度 px（留空 = 跟随模板）</label><input id="dp-set-width" type="number" min="260" max="760" step="10" placeholder="跟随模板"></div>
          <div class="dp-field"><label>我的 @ID</label><input id="dp-set-userid" type="text" placeholder="留空 = 用酒馆用户名"></div>
          <div class="dp-field" style="display:flex;align-items:flex-end;margin-bottom:0;">
            <button type="button" id="dp-btn-ids" class="dp-btn dp-btn-sm">角色 @ID 设置</button>
          </div>
        </div>

        <div class="dp-row dp-bg-block" id="dp-bg-block">
          <div class="dp-field dp-grow">
            <label>背景图（仅「背景图」模板生效；本地上传 = 下载高清无跨域）</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input id="dp-set-bg" type="text" placeholder="粘贴图片链接，或点右侧上传">
              <button type="button" id="dp-btn-bgfile" class="dp-btn dp-btn-sm">上传图片</button>
              <button type="button" id="dp-btn-bgclear" class="dp-btn dp-btn-sm">清除背景</button>
            </div>
          </div>
        </div>
        <div class="dp-row dp-bg-block" id="dp-bg-block2">
          <div class="dp-field"><label>文字颜色</label><input id="dp-set-textcolor" type="color" value="#ffffff" style="height:34px;padding:2px;width:68px"></div>
          <div class="dp-field"><label>文字字号</label><input id="dp-set-bgqsize" type="number" min="12" max="72" step="1" placeholder="22"></div>
          <div class="dp-field"><label>行距</label><input id="dp-set-bgqlh" type="number" min="1" max="3" step="0.1" placeholder="1.8"></div>
        </div>
        <div class="dp-row dp-bg-block" id="dp-bg-block3">
          <div class="dp-field dp-grow">
            <label>字体链接（仅「背景图」模板；支持 @import CSS 或 .ttf/.woff2 直链）</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <input id="dp-set-fonturl" type="text" placeholder="@import url(&quot;https://.../result.css&quot;)">
              <button type="button" id="dp-btn-fontadd" class="dp-btn dp-btn-sm">解析入库</button>
            </div>
            <div id="dp-font-lib" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div>
          </div>
        </div>
        <div class="dp-row dp-bg-block" id="dp-bg-block4">
          <div class="dp-field dp-grow">
            <label>打孔拼贴诗（点击预览上「贴纸」旁的「拼贴诗」按钮，直接在卡片预览上逐字/逐词粘贴可裁剪、可旋转的彩色纸片文字）</label>
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
              <label class="dp-check" style="display:inline-flex;align-items:center;gap:4px;margin:0">
                <input id="dp-collage-enable" type="checkbox"><span>启用拼贴模式（卡片显示拼贴诗）</span>
              </label>
              <button type="button" id="dp-btn-collage-clear" class="dp-btn dp-btn-sm">清空拼贴</button>
            </div>
          </div>
        </div>
        
        </div>
        
        <div class="dp-row">
          <div class="dp-field">
            <label>图片引擎</label>
            <select id="dp-set-engine">
              <option value="auto">自动（优先 html2canvas）</option>
              <option value="html2canvas">强制 html2canvas</option>
              <option value="svg">SVG 兜底（离线可用）</option>
            </select>
          </div>
          <div class="dp-field">
            <label>右下角入口</label>
            <select id="dp-set-launcher">
              <option value="true">显示「✎ 段评」悬浮按钮</option>
              <option value="false">隐藏</option>
            </select>
          </div>
        </div>
      </div>

    <div class="dp-modal-foot">
      <button type="button" id="dp-btn-copy" class="dp-btn">📋 复制段评</button>
      <button type="button" id="dp-btn-archive" class="dp-btn">💾 存档卡片</button>
      <button type="button" id="dp-btn-archive-list" class="dp-btn">🗂 存档列表</button>
      <button type="button" id="dp-btn-download" class="dp-btn dp-btn-primary">⬇ 下载图片</button>
    </div>
  </div>
</div>

<div id="dp-import-modal" class="dp-modal-mask dp-import-mask" style="display:none;">
  <div class="dp-modal-panel dp-import-panel">
    <div class="dp-modal-head">
      <div class="dp-modal-title">选择要拼贴的字/词 <span class="dp-sub">点击即可多选</span></div>
      <button type="button" class="dp-btn dp-btn-sm dp-import-close">×</button>
    </div>
    <div class="dp-import-toolbar">
      <span class="dp-import-modes">
        <button type="button" id="dp-import-mode-word" class="dp-btn dp-btn-sm on">按词</button>
        <button type="button" id="dp-import-mode-char" class="dp-btn dp-btn-sm">逐字</button>
      </span>
      <span class="dp-import-count" id="dp-import-count">已选 0 / 0</span>
      <span class="dp-import-actions">
        <button type="button" id="dp-import-all" class="dp-btn dp-btn-sm">全选</button>
        <button type="button" id="dp-import-none" class="dp-btn dp-btn-sm">清空</button>
      </span>
    </div>
    <div class="dp-import-list" id="dp-import-list"></div>
    <div class="dp-import-foot">
      <button type="button" id="dp-import-go" class="dp-btn dp-btn-primary" disabled>导入选中 (0)</button>
      <button type="button" id="dp-import-cancel" class="dp-btn">取消</button>
    </div>
  </div>
</div>
<div id="dp-tpl-modal" class="dp-modal-mask" style="display:none;">
  <div class="dp-modal-panel dp-tpl-panel">
    <div class="dp-modal-head">
      <div class="dp-modal-title">模板管理 <span class="dp-sub">段评卡片 CSS</span></div>
      <button type="button" class="dp-btn dp-btn-ghost dp-close" data-close="dp-tpl-modal">✕</button>
    </div>
    <div class="dp-body">
      <div class="dp-row">
        <button type="button" id="dp-tpl-new" class="dp-btn dp-btn-primary">＋ 新建模板</button>
        <button type="button" id="dp-tpl-import" class="dp-btn">导入 JSON</button>
        <span class="dp-hint dp-tpl-hint">导入格式：{"name":"模板名","css":"…"}</span>
      </div>
      <div id="dp-tpl-list" class="dp-tpl-list"></div>
      <div id="dp-tpl-editor" class="dp-tpl-editor" style="display:none;">
        <div class="dp-row">
          <div class="dp-field dp-grow"><label>模板名称</label><input id="dp-tpl-name" type="text" placeholder="模板名称"></div>
          <div class="dp-field dp-grow"><label>当前模板ID</label><input id="dp-tpl-id" type="text" readonly></div>
        </div>
        <div class="dp-field">
          <label>正文 CSS（作用于 .be-card.be-custom 卡片结构）</label>
          <textarea id="dp-tpl-css" rows="10" spellcheck="false"></textarea>
        </div>
        <div class="dp-field">
          <label>评论模块 CSS（可选，作用于 .be-comments / .be-comment，与正文分离）</label>
          <textarea id="dp-tpl-css-comments" rows="5" spellcheck="false"></textarea>
        </div>
        <div class="dp-row">
          <button type="button" id="dp-tpl-save" class="dp-btn dp-btn-primary">保存</button>
          <button type="button" id="dp-tpl-cancel" class="dp-btn">取消</button>
        </div>
      </div>
      <textarea id="dp-tpl-import-paste" class="dp-tpl-import-paste" rows="3" style="display:none;" placeholder='粘贴 {"name":"…","css":"…"} 后回车导入'></textarea>
    </div>
  </div>
</div>

<div id="dp-id-modal" class="dp-modal-mask" style="display:none;">
  <div class="dp-modal-panel" style="width:520px;">
    <div class="dp-modal-head">
      <div class="dp-modal-title">角色 @ID 设置 <span class="dp-sub">自动读取英文名，可手动覆盖</span></div>
      <button type="button" class="dp-btn dp-btn-ghost dp-close" data-close="dp-id-modal">✕</button>
    </div>
    <div class="dp-body">
      <div class="dp-field">
        <label>我的 @ID</label>
        <input id="dp-id-user" type="text" placeholder="留空 = 用酒馆用户名">
      </div>
      <div id="dp-id-list" class="dp-comment-list"></div>
    </div>
    <div class="dp-modal-foot">
      <button type="button" id="dp-id-save" class="dp-btn dp-btn-primary">保存</button>
    </div>
  </div>
</div>

<div id="dp-archive-modal" class="dp-modal-mask" style="display:none;">
  <div class="dp-modal-panel" style="width:560px;">
    <div class="dp-modal-head">
      <div class="dp-modal-title">存档卡片 <span class="dp-sub">本机保存的段评卡片，可恢复/删除/导出</span></div>
      <button type="button" class="dp-btn dp-btn-ghost dp-close" data-close="dp-archive-modal">✕</button>
    </div>
    <div class="dp-body">
      <div id="dp-archive-list" class="dp-comment-list"></div>
    </div>
    <div class="dp-modal-foot">
      <button type="button" id="dp-archive-export" class="dp-btn">导出全部 JSON</button>
      <button type="button" id="dp-archive-close" class="dp-btn dp-btn-primary">关闭</button>
    </div>
  </div>
</div>

<div id="dp-sticker-modal" class="dp-modal-mask" style="display:none;">
  <div class="dp-modal-panel" style="width:600px;">
    <div class="dp-modal-head">
      <div class="dp-modal-title">贴纸 <span class="dp-sub">点击添加到卡片，添加后可在预览里拖到任意位置</span></div>
      <button type="button" class="dp-btn dp-btn-ghost dp-close" data-close="dp-sticker-modal">✕</button>
    </div>
    <div class="dp-body">
      <div class="dp-stk-tabs">
        <button type="button" class="dp-stk-tab dp-stk-tab-on" data-tab="emoji">Emoji</button>
        <button type="button" class="dp-stk-tab" data-tab="kaomoji">颜文字</button>
        <button type="button" class="dp-stk-tab" data-tab="img">图片贴纸</button>
      </div>
      <div class="dp-stk-pane" data-pane="emoji">
        <div id="dp-stk-emoji" class="dp-stk-grid"></div>
      </div>
      <div class="dp-stk-pane" data-pane="kaomoji" style="display:none;">
        <div id="dp-stk-kaomoji" class="dp-stk-grid dp-stk-grid-kao"></div>
      </div>
      <div class="dp-stk-pane" data-pane="img" style="display:none;">
        <div class="dp-stk-upload-row">
          <button type="button" id="dp-stk-upload" class="dp-btn dp-btn-sm">➕ 上传图片贴纸</button>
          <input type="file" id="dp-stk-file" accept="image/*" style="display:none;">
          <span class="dp-tpl-hint">支持 PNG/JPG，大图自动压缩至 512px，最多 24 张</span>
        </div>
        <div id="dp-stk-img-lib" class="dp-stk-grid dp-stk-grid-img"></div>
        <div id="dp-stk-img-empty" class="dp-comment-empty" style="display:none;">还没有图片贴纸，先上传一张</div>
      </div>
      <div class="dp-stk-manage-head">
        <span>已添加到卡片（可在预览中拖拽位置）</span>
        <button type="button" id="dp-stk-clear" class="dp-btn dp-btn-sm dp-btn-danger">清除全部</button>
      </div>
      <div id="dp-sticker-manage" class="dp-comment-list"></div>
    </div>
    <div class="dp-modal-foot">
      <button type="button" id="dp-sticker-close" class="dp-btn dp-btn-primary">完成</button>
    </div>
  </div>
</div>

<div id="dp-ctx-menu" style="display:none;"></div>
`;
    document.body.appendChild(shell);

    // 浮动按钮
    document.getElementById('dp-float-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openDuanpingPanel();
    });

    // 常驻入口按钮
    const launcher = document.getElementById('dp-launcher');
    launcher.addEventListener('click', (e) => {
        e.stopPropagation();
        if (launcher._justDragged) { launcher._justDragged = false; return; }
        openDuanpingPanel();
    });
    launcher.style.display = getSettings().showLauncher ? 'flex' : 'none';
    // ===== 画笔涂鸦（内嵌工具条，ios备忘录风格） =====
    const brushBtn = document.getElementById('dp-btn-brush');
    const brushBar = document.getElementById('dp-brush-bar');
    let brushOn=false, brushCanvas=null, brushCtx=null;
    const brushState={color:'#1a1a1a', type:'pen', size:3};
    (function(){
      var box=document.getElementById('dp-brush-colors');
      if(!box) return;
      var palette=['#1a1a1a','#ffffff','#e74c3c','#e67e22','#f1c40f','#2ecc71','#3498db','#9b59b6','#e84393','#8d6e63'];
      palette.forEach(function(col){
        var b=document.createElement('button'); b.type='button';
        b.style.cssText='width:22px;height:22px;border-radius:50%;background:'+col+';border:2px solid '+(col==='#ffffff'?'#ccc':'transparent')+';cursor:pointer;padding:0;';
        b.addEventListener('click',function(){ brushState.color=col; var c=document.getElementById('dp-brush-color'); if(c)c.value=col; });
        box.appendChild(b);
      });
    })();
    function setupBrushCanvas() {
      var frame=document.getElementById("dp-frame");
      if(!frame||!frame.contentDocument)return;
      var idoc=frame.contentDocument;
      var wrap=idoc.querySelector(".dp-card-wrap");
      if(!wrap)return;
      // 每次都删旧建新，确保干净
      var oldCv=idoc.getElementById("dp-draw-canvas");
      if(oldCv) oldCv.remove();
      var cv=idoc.createElement("canvas");
      cv.id="dp-draw-canvas";
      if(getComputedStyle(wrap).position==="static") wrap.style.position="relative";
      var w=wrap.offsetWidth, h=wrap.offsetHeight;
      if(!w||!h) return;
      var dpr=window.devicePixelRatio||1;
      cv.style.cssText="position:absolute;left:0;top:0;z-index:99999;touch-action:none;width:"+w+"px;height:"+h+"px;pointer-events:auto;";
      cv.width=w*dpr; cv.height=h*dpr;
      wrap.appendChild(cv);
      var ctx=cv.getContext("2d");
      ctx.scale(dpr,dpr);
      brushCanvas=cv; brushCtx=ctx;
      var drawing=false,lastX=0,lastY=0;
      function pos(e){var r=cv.getBoundingClientRect();var p=e.touches?e.touches[0]:e;var ratio=(frame._scaleRatio||1);return{x:(p.clientX-r.left)/ratio,y:(p.clientY-r.top)/ratio};}
      function applyStyle(){
        var t=brushState.type, s=brushState.size;
        ctx.lineCap="round"; ctx.lineJoin="round";
        if(t==="eraser"){ ctx.globalCompositeOperation="destination-out"; ctx.lineWidth=s*3; ctx.globalAlpha=1; }
        else {
          ctx.globalCompositeOperation="source-over";
          ctx.strokeStyle=brushState.color; ctx.fillStyle=brushState.color;
          if(t==="pencil"){ctx.lineWidth=Math.max(1,s*0.6);ctx.globalAlpha=1;}
          else if(t==="pen"){ctx.lineWidth=s;ctx.globalAlpha=1;}
          else if(t==="crayon"){ctx.lineWidth=s*1.6;ctx.globalAlpha=0.85;}
          else if(t==="marker"){ctx.lineWidth=s*3;ctx.globalAlpha=0.5;}
          else if(t==="water"){ctx.lineWidth=s*4;ctx.globalAlpha=0.25;}
        }
      }
      cv.onmousedown=cv.ontouchstart=function(e){e.preventDefault();e.stopPropagation();drawing=true;applyStyle();var p=pos(e);lastX=p.x;lastY=p.y;if(brushState.type==="mosaic"){mosaicDot(p.x,p.y);}else{ctx.beginPath();ctx.arc(p.x,p.y,ctx.lineWidth/2,0,Math.PI*2);ctx.fill();}};
      cv.onmousemove=cv.ontouchmove=function(e){e.preventDefault();var p=pos(e);if(brushOn||mosaicOn&&'ontouchstart'in window){}if(!drawing)return;if(brushState.type==="mosaic"){var dist=Math.hypot(p.x-lastX,p.y-lastY);var step=Math.max(1,mosaicSize/4);var n=Math.max(1,Math.floor(dist/step));for(var i=1;i<=n;i++){var t=i/n;mosaicDot(lastX+(p.x-lastX)*t,lastY+(p.y-lastY)*t);}}else{ctx.beginPath();ctx.moveTo(lastX,lastY);ctx.lineTo(p.x,p.y);ctx.stroke();}lastX=p.x;lastY=p.y;};
      cv.onmouseup=cv.onmouseleave=cv.ontouchend=function(){drawing=false;};
    }
    function toggleBrush(on) {
      brushOn=on;
      if(brushBar) brushBar.style.display=on?'block':'none';
      if(brushBtn){ brushBtn.style.background=on?'#1a1a1a':''; brushBtn.style.color=on?'#fff':''; }
      if(on){
        if(mosaicOn){ mosaicOn=false; if(mosaicBar)mosaicBar.style.display="none"; if(mosaicBtn){mosaicBtn.style.background="";mosaicBtn.style.color="";}  }
        var selT=document.querySelector(".dp-brush-t.active");
        brushState.type = selT ? selT.dataset.t : "pen";
        setupBrushCanvas();
      }
    }
    if(brushBtn) brushBtn.addEventListener('click',function(){ toggleBrush(!brushOn); });
    if(brushBar){
      brushBar.querySelectorAll('.dp-brush-t').forEach(function(b){ b.addEventListener('click',function(){ brushBar.querySelectorAll('.dp-brush-t').forEach(function(x){x.classList.remove('active');x.style.background='';x.style.color='';}); b.classList.add('active'); b.style.background='#1a1a1a'; b.style.color='#fff'; brushState.type=b.dataset.t; }); });
      var sz=document.getElementById('dp-brush-size'); if(sz) sz.addEventListener('input',function(e){ brushState.size=parseInt(e.target.value)||3; });
      var col=document.getElementById('dp-brush-color'); if(col) col.addEventListener('input',function(e){ brushState.color=e.target.value; });
      var cl=document.getElementById('dp-brush-clear'); if(cl) cl.addEventListener('click',function(){ if(brushCtx&&brushCanvas) brushCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height); });
      var dn=document.getElementById('dp-brush-done'); if(dn) dn.addEventListener('click',function(){ toggleBrush(false); });
    }
    // ===== 马赛克（涂抹式）+ 放大镜（防手指遮挡） =====
    const mosaicBtn = document.getElementById('dp-btn-mosaic');
    const mosaicBar = document.getElementById('dp-mosaic-bar');
    let mosaicOn=false, mosaicStyle='blocks', mosaicSize=14;

    let mosaicSrcCv=null, mosaicSrcReady=false;
    function initMosaicSource() {
      mosaicSrcReady=false;
      var frame=document.getElementById("dp-frame");
      if(!frame||!frame.contentWindow||!frame.contentDocument) return;
      var card=frame.contentDocument.querySelector(".dp-card-wrap");
      if(!card) return;
      ensureHtml2canvas(frame).then(function(h2c){
        h2c(card,{scale:1,useCORS:true,backgroundColor:null,width:card.offsetWidth,height:card.offsetHeight,logging:false}).then(function(offCv){
          mosaicSrcCv=offCv;
          mosaicSrcReady=true;
        });
      });
    }
    function mosaicDot(cx, cy) {
      if (!brushCtx) return;
      var s = mosaicSize;
      brushCtx.save();
      brushCtx.globalCompositeOperation = "source-over";
      if (mosaicStyle === "blur") {
        // 模糊：半透明灰圆
        brushCtx.fillStyle = "rgba(100,100,100,0.45)";
        brushCtx.beginPath(); brushCtx.arc(cx, cy, s/2, 0, Math.PI*2); brushCtx.fill();
      } else if (mosaicStyle === "solid") {
        // 纯色：实心深灰圆
        brushCtx.fillStyle = "#666";
        brushCtx.beginPath(); brushCtx.arc(cx, cy, s/2, 0, Math.PI*2); brushCtx.fill();
      } else if (mosaicStyle === "pixel") {
        // 像素：小方块棋盘格
        var ps = Math.max(3, Math.floor(s/4));
        var sx = Math.floor((cx-s/2)/ps)*ps, sy = Math.floor((cy-s/2)/ps)*ps;
        for (var y=sy; y<cy+s/2; y+=ps) {
          for (var x=sx; x<cx+s/2; x+=ps) {
            var idx = Math.round(x/ps)+Math.round(y/ps);
            brushCtx.fillStyle = (idx%2===0) ? "#888" : "#aaa";
            brushCtx.fillRect(x, y, ps, ps);
          }
        }
      } else {
        // 方块：大块灰色方块
        var ps2 = Math.max(6, Math.floor(s/1.5));
        var sx2 = Math.floor((cx-s/2)/ps2)*ps2, sy2 = Math.floor((cy-s/2)/ps2)*ps2;
        brushCtx.fillStyle = "#999";
        for (var y=sy2; y<cy+s/2; y+=ps2) {
          for (var x=sx2; x<cx+s/2; x+=ps2) {
            brushCtx.fillRect(x, y, ps2, ps2);
          }
        }
      }
      brushCtx.restore();
    }
    function toggleMosaic(on) {
      mosaicOn = on;
      if (mosaicBar) mosaicBar.style.display = on ? 'block' : 'none';
      if (mosaicBtn) { mosaicBtn.style.background = on ? '#1a1a1a' : ''; mosaicBtn.style.color = on ? '#fff' : ''; }
      if (on) {
        // 互斥：开马赛克时关画笔
        if(brushOn){ brushOn=false; if(brushBar)brushBar.style.display='none'; if(brushBtn){brushBtn.style.background='';brushBtn.style.color='';} }
        setupBrushCanvas();
        brushState.type = 'mosaic';
      } else {
        
      }
    }
    if (mosaicBtn) mosaicBtn.addEventListener('click', function(){ toggleMosaic(!mosaicOn); });
    if (mosaicBar) {
      mosaicBar.querySelectorAll('.dp-mosaic-t').forEach(function(b){ b.addEventListener('click', function(){ mosaicBar.querySelectorAll('.dp-mosaic-t').forEach(function(x){x.classList.remove('active');x.style.background='';x.style.color='';}); b.classList.add('active'); b.style.background='#1a1a1a'; b.style.color='#fff'; mosaicStyle = b.dataset.m; }); });
      var sz = document.getElementById('dp-mosaic-size');
      if (sz) sz.addEventListener('input', function(e){ mosaicSize = parseInt(e.target.value) || 14; });
      document.getElementById('dp-mosaic-clear').addEventListener('click', function(){
        if (brushCtx && brushCanvas) brushCtx.clearRect(0,0,brushCanvas.width,brushCanvas.height);
      });
      document.getElementById('dp-mosaic-done').addEventListener('click', function(){ toggleMosaic(false); });
    }
    // launcher 可拖动 + 记忆位置
    (function(){
      var saved=null; try{ saved=JSON.parse(localStorage.getItem('dp-launcher-pos')||'null'); }catch(e){}
      if(saved && typeof saved.x==='number'){
        launcher.style.left=saved.x+'px'; launcher.style.top=saved.y+'px';
        launcher.style.right='auto'; launcher.style.bottom='auto';
      }
      var sx=0,sy=0,ox=0,oy=0,dragging=false,moved=false;
      launcher.addEventListener('pointerdown',function(e){
        dragging=true; moved=false;
        var r=launcher.getBoundingClientRect(); ox=r.left; oy=r.top;
        sx=e.clientX; sy=e.clientY;
        try{ launcher.setPointerCapture(e.pointerId); }catch(err){}
        launcher.style.right='auto'; launcher.style.bottom='auto';
      });
      launcher.addEventListener('pointermove',function(e){
        if(!dragging)return;
        var dx=e.clientX-sx, dy=e.clientY-sy;
        if(Math.abs(dx)+Math.abs(dy)>5) moved=true;
        if(moved){
          var nx=Math.max(4,Math.min(ox+dx,window.innerWidth-launcher.offsetWidth-4));
          var ny=Math.max(4,Math.min(oy+dy,window.innerHeight-launcher.offsetHeight-4));
          launcher.style.left=nx+'px'; launcher.style.top=ny+'px';
        }
      });
      launcher.addEventListener('pointerup',function(){
        dragging=false;
        if(moved){
          launcher._justDragged=true;
          try{ localStorage.setItem('dp-launcher-pos',JSON.stringify({x:parseInt(launcher.style.left),y:parseInt(launcher.style.top)})); }catch(err){}
          setTimeout(function(){ launcher._justDragged=false; },50);
        }
      });
    })();

    // 关闭按钮
    document.querySelectorAll('.dp-close').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.close;
            document.getElementById(id).style.display = 'none';
            if (id === 'dp-modal') {
                // 关闭面板时清空选区，避免误触
                closeCollageEditor(false);
                hideFloatButton();
            }
        });
    });

    // 点击遮罩关闭
    ['dp-modal', 'dp-tpl-modal'].forEach((id) => {
        document.getElementById(id).addEventListener('click', (e) => {
            if (e.target.id === id) {
                e.target.style.display = 'none';
                if (id === 'dp-modal') closeCollageEditor(false);
            }
        });
    });

    // 主面板事件
    document.getElementById('dp-btn-generate').addEventListener('click', generateRatings);
    document.getElementById('dp-btn-download').addEventListener('click', downloadCardImage);
    document.getElementById('dp-btn-copy').addEventListener('click', async () => {
        const texts = (dp.comments || []).map((c) => `${c.authorName}：${c.text}`).join('\n\n');
        if (!texts) return toast('warning', '还没有段评内容');
        try {
            await navigator.clipboard.writeText(texts);
            toast('success', '已复制全部段评');
        } catch {
            toast('error', '复制失败，请手动复制');
        }
    });
    document.getElementById('dp-btn-manage-tpl').addEventListener('click', openTemplateManager);

    const quoteInput = document.getElementById('dp-quote-input');
    quoteInput.addEventListener('input', debounce(() => renderCard(), 400));
    document.getElementById('dp-btn-add-user-comment').addEventListener('click', addUserComment);
    const userCommentInput = document.getElementById('dp-user-comment-input');
    userCommentInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addUserComment();
    });

    // iframe 加载完成后自适应高度
    const dpFrame = document.getElementById('dp-frame');
    if (dpFrame) dpFrame.addEventListener("load", function(){ fitFrame(); if(brushOn||mosaicOn){ setTimeout(setupBrushCanvas, 200); } });
    document.getElementById('dp-extra-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') generateRatings();
    });
    document.getElementById('dp-tpl-select').addEventListener('change', async (e) => {
        const settings = getSettings();
        settings.activeTemplateId = e.target.value;
        saveSettingsDebounced();
        await renderCard();
    });

    // 设置区定位（头部按钮 → 滚动到主面板内的设置区块，桌面/手机通用）
    const advBtn = document.getElementById('dp-btn-advanced');
    advBtn.addEventListener('click', () => {
        const bodyEl = document.getElementById('dp-modal')?.querySelector('.dp-body');
        const sec = document.getElementById('dp-modal')?.querySelector('.dp-advanced');
        if (bodyEl && sec) {
            const top = sec.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top + bodyEl.scrollTop;
            bodyEl.scrollTop = Math.max(0, top - 10);
        }
    });
    const bindSetting = (inputId, key, onChange) => {
        const el = document.getElementById(inputId);
        if (!el) return;
        const normalize = (raw) => (key === 'showLauncher' ? raw === 'true' : raw);
        const save = () => {
            const settings = getSettings();
            settings[key] = normalize(el.value);
            saveSettingsDebounced();
            if (onChange) onChange(settings[key]);
        };
        el.addEventListener('change', save);
        el.addEventListener('input', () => {
            const settings = getSettings();
            settings[key] = normalize(el.value);
            saveSettingsDebounced();
        });
    };
    bindSetting('dp-set-title', 'bookTitle', () => renderCard());
    bindSetting('dp-set-chapter', 'chapterText', () => renderCard());
    bindSetting('dp-set-watermark', 'watermarkText', () => renderCard());
    bindSetting('dp-set-qsize', 'quoteSize', () => renderCard());
    bindSetting('dp-set-qlh', 'quoteLh', () => renderCard());
    bindSetting('dp-set-qls', 'quoteLs', () => renderCard());
    bindSetting('dp-set-prompt', 'promptTemplate');
    bindSetting('dp-set-engine', 'captureEngine');
    bindSetting('dp-set-launcher', 'showLauncher', () => {
        const s = getSettings();
        const el = document.getElementById('dp-launcher');
        if (el) el.style.display = s.showLauncher ? 'flex' : 'none';
    });
    // 图片宽度（数字，留空=跟随模板）
    bindSetting('dp-set-width', 'cardWidth', () => { renderCard(); syncWidthSlider(); });
    bindSetting('dp-set-userid', 'userId');
    // 背景图模板：URL 输入 或 本地上传（base64，下载无跨域问题）
    bindSetting('dp-set-bg', 'bgImage', () => renderCard());
    bindSetting('dp-set-textcolor', 'textColor', () => renderCard());
    bindSetting('dp-set-bgqsize', 'bgQuoteSize', () => renderCard());
    bindSetting('dp-set-bgqlh', 'bgQuoteLh', () => renderCard());
    bindSetting('dp-set-fonturl', 'fontUrl', async () => {
        const st = getSettings();
        // 字体链接变化：清掉旧缓存的 base64/分片与 URL 标记，避免旧字体一直生效（换字体后新字体不生效）
        st.fontB64 = '';
        st.fontCssKey = '';
        st._fontB64Url = '';
        st._fontCssUrl = '';
        const raw = (st.fontUrl || '').trim();
        if (!raw) {
            st.fontFamily = '';
            saveSettingsDebounced();
            renderCard();
            return;
        }
        saveSettingsDebounced();
        // 粘贴即用：字体直链自动转 base64；@import CSS/链接自动解析入库并提取家族名（不再依赖手动点字体库条目）
        if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(raw) || /^data:/i.test(raw)) {
            try {
                const resp = await fetch(raw);
                if (resp.ok) {
                    const blob = await resp.blob();
                    st.fontB64 = await new Promise((res) => { const rd = new FileReader(); rd.onload = () => res(String(rd.result)); rd.readAsDataURL(blob); });
                    if (!st.fontFamily) st.fontFamily = 'font_' + ((st.fontLib || []).length + 1);
                }
            } catch (e) { /* 跨域失败保留原链接 */ }
        } else if (raw.includes('@import') || raw.includes('@font-face') || /\.css(\?|#|$)/i.test(raw)) {
            try {
                const r = await parseFontCssAuto(raw);
                if (r && r.family) {
                    st.fontFamily = r.family;
                    if (r.url && r.url !== raw) st.fontUrl = r.url;
                }
            } catch (e) { toast('warning', '字体解析失败：' + (e.message || '网络/跨域问题')); }
        }
        saveSettingsDebounced();
        await ensureFontB64(st);
        renderFontLib();
        renderCard();
    });
    const fontInputEl = document.getElementById('dp-set-fonturl');
    if (fontInputEl) {
        fontInputEl.addEventListener('input', debounce(() => {
            const st = getSettings();
            if (!st.fontUrl) {
                st.fontB64 = '';
                st.fontCssKey = '';
                st.fontFamily = '';
                saveSettingsDebounced();
                renderCard();
                return;
            }
            st.fontB64 = '';
            ensureFontB64(st, true).then(() => renderCard());
        }, 800));
    }
    const bgFileInput = document.createElement('input');
    bgFileInput.type = 'file';
    bgFileInput.accept = 'image/*';
    bgFileInput.style.display = 'none';
    document.body.appendChild(bgFileInput);
    bgFileInput.addEventListener('change', () => {
        const f = bgFileInput.files && bgFileInput.files[0];
        if (!f) return;
        if (f.size > 15 * 1024 * 1024) { toast('warning', '背景图过大（≤15MB）'); return; }
        const rd = new FileReader();
        rd.onload = () => {
            const s = getSettings();
            s.bgImage = String(rd.result);
            saveSettingsDebounced();
            const inp = document.getElementById('dp-set-bg');
            if (inp) inp.value = '已上传图片（base64）';
            renderCard();
        };
        rd.readAsDataURL(f);
    });
    const btnBgFile = document.getElementById('dp-btn-bgfile');
    if (btnBgFile) btnBgFile.addEventListener('click', () => bgFileInput.click());
    const btnBgClear = document.getElementById('dp-btn-bgclear');
    if (btnBgClear) btnBgClear.addEventListener('click', () => {
        const s = getSettings();
        s.bgImage = '';
        saveSettingsDebounced();
        const inp = document.getElementById('dp-set-bg');
        if (inp) inp.value = '';
        renderCard();
    });
    const btnFontAdd = document.getElementById('dp-btn-fontadd');
    if (btnFontAdd) btnFontAdd.addEventListener('click', () => parseFontLink());
    renderFontLib();

    // 宽度滑杆（0 = 跟随模板；>0 = 固定 px，与高级设置输入框双向同步）
    const widthSlider = document.getElementById('dp-width-slider');
    const widthVal = document.getElementById('dp-width-val');
    const syncWidthSlider = () => {
        if (!widthSlider || !widthVal) return;
        const v = Number(getSettings().cardWidth) || 0;
        widthSlider.value = Math.min(Math.max(v, 0), 720);
        widthVal.textContent = v > 0 ? `${v}px` : '跟随模板';
        try { var fr=document.getElementById("dp-frame"); if(fr&&fr.contentDocument){ var cw=fr.contentDocument.querySelector(".dp-card-wrap"); if(cw){ if(v>0){cw.style.width=v+"px";cw.style.maxWidth="none";}else{cw.style.width="";cw.style.maxWidth="";} fitFrame(); } } } catch(e){}
        const num = document.getElementById('dp-set-width');
        if (num) num.value = v > 0 ? String(v) : '';
    };
    widthSlider.addEventListener('input', () => {
        const v = Number(widthSlider.value) || 0;
        getSettings().cardWidth = v;
        saveSettingsDebounced();
        widthVal.textContent = v > 0 ? `${v}px` : '跟随模板';
        const num = document.getElementById('dp-set-width');
        if (num) num.value = v > 0 ? String(v) : '';
    });
    widthSlider.addEventListener('change', () => { saveSettingsDebounced(); renderCard(); });

    // 日间/夜间切换
    const nightBtn = document.getElementById('dp-btn-night');
    const syncNightBtn = () => {
        if (!nightBtn) return;
        nightBtn.textContent = getSettings().nightMode ? '☀️ 日间' : '🌙 夜间';
        nightBtn.classList.toggle('dp-night-on', !!getSettings().nightMode);
    };
    nightBtn.addEventListener('click', () => {
        const s = getSettings();
        s.nightMode = !s.nightMode;
        saveSettingsDebounced();
        syncNightBtn();
        renderCard();
        toast(s.nightMode ? '已切换夜间模式' : '已切换日间模式');
    });

    // 自填 API
    document.getElementById('dp-api-enable').addEventListener('change', (e) => {
        getSettings().apiEnabled = e.target.checked;
        saveSettingsDebounced();
        if (e.target.checked) refreshModelSelect();
    });
    ['dp-api-url', 'dp-api-key'].forEach((id) => {
        document.getElementById(id).addEventListener('change', (e) => {
            getSettings()[id === 'dp-api-url' ? 'apiUrl' : 'apiKey'] = e.target.value.trim();
            saveSettingsDebounced();
        });
    });
    document.getElementById('dp-api-model').addEventListener('change', (e) => {
        getSettings().apiModel = e.target.value;
        saveSettingsDebounced();
    });
    document.getElementById('dp-api-models').addEventListener('click', refreshModelSelect);
    document.getElementById('dp-api-test').addEventListener('click', testApiConnection);
    document.getElementById('dp-btn-ids').addEventListener('click', openIdModal);
    document.getElementById('dp-id-save').addEventListener('click', saveIdSettings);

    // 存档卡片
    document.getElementById('dp-btn-archive').addEventListener('click', saveCurrentArchive);
    document.getElementById('dp-btn-archive-list').addEventListener('click', openArchiveModal);
    document.getElementById('dp-archive-export').addEventListener('click', exportArchives);
    document.getElementById('dp-archive-close').addEventListener('click', () => {
        document.getElementById('dp-archive-modal').style.display = 'none';
    });

    // 贴纸
    document.getElementById('dp-btn-sticker').addEventListener('click', openStickerModal);
    document.getElementById('dp-sticker-close').addEventListener('click', () => {
        document.getElementById('dp-sticker-modal').style.display = 'none';
    });

    // ===== 打孔拼贴诗 =====
    const collageOpenBtn = document.getElementById('dp-btn-collage');
    if (collageOpenBtn) collageOpenBtn.addEventListener('click', () => { if (collageState.open) closeCollageEditor(true); else openCollageEditor(); });
    const collageClearBtn = document.getElementById('dp-btn-collage-clear');
    if (collageClearBtn) collageClearBtn.addEventListener('click', () => {
        if (!getSettings().collageWords || !getSettings().collageWords.length) { toast('info', '当前没有拼贴词条'); return; }
        getSettings().collageWords = [];
        saveSettingsDebounced();
        renderCard();
        toast('success', '已清空拼贴词条');
    });
    const syncCollageEnable = () => {
        const s = getSettings();
        ['dp-collage-enable', 'dp-collage-enable2'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!s.collageEnabled;
        });
    };
    const bindCollageEnable = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', (e) => {
            getSettings().collageEnabled = e.target.checked;
            saveSettingsDebounced();
            syncCollageEnable();

            renderCard();
            if (collageState.open) renderCollageCanvas();
            toast('success', e.target.checked ? '已启用拼贴模式' : '已关闭拼贴模式（回到普通背景图模板）');
        });
    };
    bindCollageEnable('dp-collage-enable');
    bindCollageEnable('dp-collage-enable2');
    // 拼贴直操作（贴纸旁的「拼贴诗」按钮 + 预览下方工具条）：直接在预览上添加/拖动纸片
    const cbBtn = document.getElementById('dp-btn-collage-main');
    if (cbBtn) cbBtn.addEventListener('click', toggleCollageBar);
    const cbAdd = document.getElementById('dp-cb-add');
    if (cbAdd) cbAdd.addEventListener('click', () => collageBarAddWord());
    const cbInput = document.getElementById('dp-cb-input');
    if (cbInput) cbInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') collageBarAddWord(); });
    ['dp-cb-shape', 'dp-cb-paper', 'dp-cb-bg', 'dp-cb-fg', 'dp-cb-size', 'dp-cb-w', 'dp-cb-h', 'dp-cb-rot'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const apply = () => {
            const i = collageState.sel;
            if (i < 0) return;
            const s = getSettings();
            const w = s.collageWords && s.collageWords[i];
            if (!w) return;
            if (id === 'dp-cb-shape') w.shape = el.value;
            else if (id === 'dp-cb-paper') { w.paper = el.value; if (el.value === 'custom') { const fup = document.getElementById('dp-paper-upload'); if (fup) fup.click(); } else if (el.value && el.value.indexOf('mat') === 0) { collageLoadBuiltinPaper(el.value); } }
            else if (id === 'dp-cb-bg') w.bg = el.value;
            else if (id === 'dp-cb-fg') w.fg = el.value;
            else if (id === 'dp-cb-size') w.size = Math.max(8, Math.min(300, Number(el.value) || 20));
            else if (id === 'dp-cb-w') w.w = Math.max(20, Math.min(1000, Number(el.value) || 120));
            else if (id === 'dp-cb-h') w.h = Math.max(20, Math.min(1000, Number(el.value) || 80));
            else if (id === 'dp-cb-rot') w.rot = Math.max(-360, Math.min(360, Number(el.value) || 0));
            saveSettingsDebounced();
            renderCard();
        };
        el.addEventListener('input', apply);
        el.addEventListener('change', apply);
    });
    const fupEl = document.getElementById('dp-paper-upload');
    if (fupEl) fupEl.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        const s = getSettings();
        const i = collageState.sel;
        if (!f) {
            if (i >= 0 && s.collageWords && s.collageWords[i]) s.collageWords[i].paper = 'plain';
            const psel = document.getElementById('dp-cb-paper');
            if (psel) psel.value = 'plain';
            saveSettingsDebounced(); renderCard(); return;
        }
        const rd = new FileReader();
        rd.onload = () => {
            s.collagePaperImg = String(rd.result);
            collagePaperImgObj = null;
            saveSettingsDebounced();
            const im = new Image();
            im.onload = () => { collagePaperImgObj = im; renderCollageCanvas(); };
            im.onerror = () => { collagePaperImgObj = null; };
            im.src = String(rd.result);
            renderCard();
        };
        rd.readAsDataURL(f);
    });
    const tintEl = document.getElementById('dp-cb-tint');
    const tintSEl = document.getElementById('dp-cb-tint-s');
    if (tintEl || tintSEl) {
        const sT = getSettings();
        if (tintEl) { tintEl.value = sT.collagePaperTint || '#8b5a2b'; tintEl.addEventListener('input', () => { getSettings().collagePaperTint = tintEl.value; saveSettingsDebounced(); renderCollageCanvas(); }); }
        if (tintSEl) { tintSEl.value = String(sT.collagePaperTintStrength || 0); tintSEl.addEventListener('input', () => { getSettings().collagePaperTintStrength = Number(tintSEl.value); saveSettingsDebounced(); renderCollageCanvas(); }); }
    }
    const cbDel = document.getElementById('dp-cb-del');
    if (cbDel) cbDel.addEventListener('click', () => {
        const i = collageState.sel;
        const s = getSettings();
        if (i < 0 || !s.collageWords || !s.collageWords[i]) return;
        s.collageWords.splice(i, 1);
        saveSettingsDebounced();
        collageState.sel = -1;
        renderCard();
    });
    const cbClear = document.getElementById('dp-cb-clear');
    if (cbClear) cbClear.addEventListener('click', () => {
        const s = getSettings();
        if (!s.collageWords || !s.collageWords.length) return;
        s.collageWords = [];
        saveSettingsDebounced();
        collageState.sel = -1;
        renderCard();
    });
    const cbClose = document.getElementById('dp-cb-close');
    if (cbClose) cbClose.addEventListener('click', () => {
        const s = getSettings();
        s.collageEnabled = true; // 完成编辑：保留拼贴，收起工具条
        saveSettingsDebounced();
        const bar = document.getElementById('dp-collage-bar');
        if (bar) bar.style.display = 'none';
        const btn = document.getElementById('dp-btn-collage-main');
        if (btn) btn.textContent = '✂ 拼贴诗';
    });
    const cbImport = document.getElementById('dp-cb-import');
    if (cbImport) cbImport.addEventListener('click', () => { collageOpenImportPicker(); });

    const collageInput = document.getElementById('dp-collage-input');
    if (collageInput) {
        collageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                collageAddWord(collageInput.value);
            }
        });
        document.getElementById('dp-collage-add').addEventListener('click', () => collageAddWord(collageInput.value));
    }
    const collageImportBtn = document.getElementById('dp-collage-import');
    if (collageImportBtn) collageImportBtn.addEventListener('click', collageOpenImportPicker);
    const pickArea = document.getElementById('dp-collage-pick');
    if (pickArea) {
        pickArea.addEventListener('click', (e) => {
            const chip = e.target.closest('.dp-pick-chip');
            if (chip) {
                const idx = Number(chip.dataset.i);
                const txt = collageImportCandidates[idx];
                if (!txt) return;
                if (collageImportMode === 'free') {
                    if (collageImportSelected.has(idx)) collageImportSelected.delete(idx);
                    collageRenderImportPicker();
                    return;
                }
                collageImportSelected.add(idx);
                collageBarAddWord(txt);
                collageRenderImportPicker();
                toast('success', `已把「${txt}」贴到画布`);
                return;
            }
            if (e.target.closest('#dp-pick-addsel')) {
                const sel = window.getSelection && window.getSelection();
                const txt = String(sel && sel.toString ? sel.toString() : '').trim();
                if (!txt) { toast('warning', '请先在原文上圈选一段文字'); return; }
                if (collageImportCandidates.includes(txt)) { toast('info', `「${txt}」已在列表`); try { sel.removeAllRanges && sel.removeAllRanges(); } catch (err) { /* noop */ } return; }
                const i = collageImportCandidates.length;
                collageImportCandidates.push(txt);
                collageImportSelected.add(i);
                collageRenderImportPicker();
                collageBarAddWord(txt);
                try { sel.removeAllRanges && sel.removeAllRanges(); } catch (err) { /* noop */ }
                return;
            }
            if (e.target.closest('#dp-pick-import')) {
                collageImportPicked();
                return;
            }
            if (e.target.closest('#dp-pick-close')) { pickArea.style.display = 'none'; return; }
        });
        const setMode = (mode) => {
            collageImportMode = mode;
            collageImportSelected = new Set();
            const qi = document.getElementById('dp-quote-input');
            const raw = qi ? qi.value : '';
            if (mode === 'free') {
                collageImportCandidates = [];
                const st = document.getElementById('dp-pick-source-text');
                if (st) st.textContent = raw;
            } else {
                collageImportCandidates = collageSplitText(raw, collageImportMode);
            }
            collageRenderImportPicker();
        };
        const mw = document.getElementById('dp-pick-mode-word');
        const mc = document.getElementById('dp-pick-mode-char');
        const mf = document.getElementById('dp-pick-mode-free');
        if (mw) mw.addEventListener('click', () => setMode('word'));
        if (mc) mc.addEventListener('click', () => setMode('char'));
        if (mf) mf.addEventListener('click', () => setMode('free'));
    }
    const collageClearAllBtn = document.getElementById('dp-collage-clear-all');
    if (collageClearAllBtn) collageClearAllBtn.addEventListener('click', () => {
        if (!getSettings().collageWords || !getSettings().collageWords.length) return;
        getSettings().collageWords = [];
        saveSettingsDebounced();
        collageState.sel = -1;
        collageRenderControls();
        renderCollageCanvas();
    });
    const collageDelBtn = document.getElementById('dp-collage-del');
    if (collageDelBtn) collageDelBtn.addEventListener('click', collageDeleteSelected);
    ['dp-collage-shape', 'dp-collage-bg', 'dp-collage-fg', 'dp-collage-size', 'dp-collage-rot'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        const apply = () => {
            const i = collageState.sel;
            if (i < 0) return;
            const s = getSettings();
            const w = s.collageWords[i];
            if (!w) return;
            if (id === 'dp-collage-shape') w.shape = el.value;
            else if (id === 'dp-collage-bg') w.bg = el.value;
            else if (id === 'dp-collage-fg') w.fg = el.value;
            else if (id === 'dp-collage-size') w.size = Math.max(8, Math.min(300, Number(el.value) || 20));
            else if (id === 'dp-collage-rot') w.rot = Math.max(-360, Math.min(360, Number(el.value) || 0));
            saveSettingsDebounced();
            renderCollageCanvas();
        };
        el.addEventListener('input', apply);
        el.addEventListener('change', apply);
    });
    const collageAlignGrid = document.getElementById('dp-collage-align');
    if (collageAlignGrid) {
        collageAlignGrid.addEventListener('click', (e) => {
            const cell = e.target.closest('.dp-align-cell');
            if (!cell) return;
            const i = collageState.sel;
            if (i < 0) { toast('info', '请先在画布上选中一个纸片，再点对齐'); return; }
            const w = getSettings().collageWords[i];
            if (!w) return;
            w.ah = cell.dataset.a;
            w.av = cell.dataset.b;
            saveSettingsDebounced();
            collageRenderControls();
            renderCollageCanvas();
        });
    }
    const collageBgColorInput = document.getElementById('dp-collage-bgcolor');
    if (collageBgColorInput) {
        collageBgColorInput.addEventListener('input', () => {
            getSettings().collageBgColor = collageBgColorInput.value;
            saveSettingsDebounced();
            renderCollageCanvas();
        });
    }
    const collageDoneBtn = document.getElementById('dp-collage-done');
    if (collageDoneBtn) collageDoneBtn.addEventListener('click', () => closeCollageEditor(true));
    bindCollageCanvas();
    syncCollageEnable();
    document.getElementById('dp-stk-clear').addEventListener('click', () => {
        getSettings().stickers = [];
        saveSettingsDebounced();
        renderStickerManageList();
        renderCard();
        toast('success', '已清除全部贴纸');
    });
    // 贴纸分类 tab
    document.querySelectorAll('.dp-stk-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.dp-stk-tab').forEach((t) => t.classList.remove('dp-stk-tab-on'));
            tab.classList.add('dp-stk-tab-on');
            const name = tab.dataset.tab;
            document.querySelectorAll('.dp-stk-pane').forEach((p) => {
                p.style.display = p.dataset.pane === name ? '' : 'none';
            });
        });
    });
    // 上传图片贴纸（大图自动压缩至 512px，透明 PNG 优先）
    document.getElementById('dp-stk-upload').addEventListener('click', () => {
        document.getElementById('dp-stk-file').click();
    });
    document.getElementById('dp-stk-file').addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        if (!/^image\//.test(file.type)) {
            toast('warning', '请选择图片文件');
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            toast('warning', '图片过大（≤10MB）');
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const raw = String(reader.result);
            compressStickerImage(raw, (data) => {
                const lib = stickerImageLib();
                lib.push({ id: `si_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`, data });
                saveStickerImageLib(lib);
                renderStickerImgLib();
                toast('success', '图片贴纸已添加');
            });
        };
        reader.readAsDataURL(file);
    });

    // 模板管理事件
    document.getElementById('dp-tpl-new').addEventListener('click', () => openTemplateEditor(null));
    document.getElementById('dp-tpl-import').addEventListener('click', () => {
        const box = document.getElementById('dp-tpl-import-paste');
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
        if (box.style.display === 'block') box.focus();
    });
    document.getElementById('dp-tpl-import-paste').addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const v = e.target.value.trim();
        if (!v) return;
        try {
            const json = JSON.parse(v);
            if (typeof json.css !== 'string') throw new Error('缺少 css 字段');
            createCustomTemplate(json.name || '导入模板', json.css, json.comments);
            e.target.value = '';
            e.target.style.display = 'none';
            toast('success', `已导入模板「${json.name || '导入模板'}」`);
            refreshTemplateManager();
            refreshTemplateSelect();
        } catch (err) {
            toast('error', `JSON 解析失败：${err?.message || err}`);
        }
    });
    document.getElementById('dp-tpl-save').addEventListener('click', saveTemplateEditor);
    document.getElementById('dp-tpl-cancel').addEventListener('click', () => {
        document.getElementById('dp-tpl-editor').style.display = 'none';
    });

    // Esc 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            hideDpContextMenu();
            ['dp-tpl-modal', 'dp-modal', 'dp-id-modal', 'dp-archive-modal', 'dp-sticker-modal'].forEach((id) => {
                const el = document.getElementById(id);
                if (el && el.style.display !== 'none') el.style.display = 'none';
            });
        }
    });

    // 选区监听
    document.addEventListener('selectionchange', onSelectionChange);
    // 手机端部分浏览器长按选择不触发 selectionchange，touchend 后延迟兜底检查一次
    // （双时间点：60ms 覆盖多数浏览器，400ms 覆盖原生选择完成后才出选区句柄的慢速浏览器）
    document.addEventListener('touchend', () => setTimeout(onSelectionChange, 60));
    document.addEventListener('touchend', () => setTimeout(onSelectionChange, 400));
    document.addEventListener('mouseup', (e) => {
        if (e.target.closest('#dp-float-btn') || e.target.closest('#dp-modal') || e.target.closest('#dp-tpl-modal') || e.target.closest('#dp-ctx-menu')) return;
        setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) hideFloatButton();
        }, 0);
    });

    // ===== 右键唤醒（微信"提取文本"式） =====
    const ctxMenu = document.getElementById('dp-ctx-menu');
    ctxMenu.addEventListener('mousedown', (e) => e.preventDefault()); // 防止点击吃掉选中状态
    document.addEventListener('contextmenu', (e) => {
        if (e.target.closest('#dp-modal') || e.target.closest('#dp-tpl-modal') || e.target.closest('#dp-ctx-menu')) return;
        const textEl = e.target.closest('.mes_text');
        if (!textEl) return; // 不在消息文本上 → 保留浏览器默认菜单
        const sel = window.getSelection();
        const existing = getSelectionContext(sel);
        // 触屏端不拦截 contextmenu：拦截会取消 iOS / 部分安卓浏览器、内置浏览器的原生长按选择手柄，
        // 导致手机端选不了段（“提取本段”自定义菜单仅保留给桌面右键 e.button===2）。
        // 触屏端改走原生长按 → selectionchange / touchend 兜底 → 浮动「✎ 段评」按钮完成交互。
        if (isTouchDevice() && e.button !== 2) {
            e.preventDefault();
            openPickLayer(textEl.textContent || '');
            return;
        }
        if (!isTouchDevice()) return;
        e.preventDefault();
        openDpContextMenu(e.clientX, e.clientY, textEl, existing);
    });
    document.addEventListener('mousedown', (e) => {
        if (dp.ctxMenuOpen && !e.target.closest('#dp-ctx-menu')) hideDpContextMenu();
    });
    document.addEventListener('scroll', hideDpContextMenu, true);
}

// =====================================================================
// 右键唤醒 · 微信"提取文本"式选段
// =====================================================================

/** 触屏设备检测（手机 / 平板 / 触屏笔记本）：触屏端长按走浏览器原生长按选择，不拦截 contextmenu */
function isTouchDevice() {
    try {
        return ('ontouchstart' in window) || (typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0);
    } catch (e) { return false; }
}
// 手机端 逐字点选层（仿微信"图片提取文本"）
function openPickLayer(text) {
    if (!text || !text.trim()) { toast('info', '这段没有可点选的文字'); return; }
    let layer = document.getElementById('dp-pickover');
    if (!layer) {
        layer = document.createElement('div');
        layer.id = 'dp-pickover';
        layer.innerHTML = '<div class="dp-pick-panel"><div class="dp-pick-head">点选要做成段评的文字（可逐字/逐词组合）<span class="dp-pick-manual">手动拖选</span></div><div class="dp-pick-text" id="dp-pick-text"></div><div class="dp-pick-bar"><button class="dp-pick-cancel">取消</button><button class="dp-pick-ok">确认</button></div></div>';
        document.body.appendChild(layer);
        layer.querySelector('.dp-pick-cancel').addEventListener('click', closePickLayer);
        layer.querySelector('.dp-pick-ok').addEventListener('click', confirmPick);
        var mb = layer.querySelector('.dp-pick-manual');
        if (mb) mb.addEventListener('click', function(){ closePickLayer(); toast('info','已切换手动选择：按住文字拖动选中，松开后点「✎ 段评」'); });
    }
    const box = layer.querySelector('#dp-pick-text');
    box.innerHTML = '';
    Array.from(text).forEach(function(ch) {
        const s = document.createElement('span');
        s.className = 'dp-b' + (ch === ' ' ? ' space' : '');
        s.textContent = ch;
        s.addEventListener('click', function() { s.classList.toggle('on'); });
        box.appendChild(s);
    });
    layer.classList.add('show');
}
function closePickLayer() {
    const layer = document.getElementById('dp-pickover');
    if (layer) layer.classList.remove('show');
}
function confirmPick() {
    const layer = document.getElementById('dp-pickover');
    if (!layer) return;
    const picked = Array.from(layer.querySelectorAll('.dp-b.on')).map(function(s){return s.textContent;}).join('');
    closePickLayer();
    if (!picked.trim()) { toast('info', '请先点选文字'); return; }
    const qi = document.getElementById('dp-quote-input');
    if (qi) qi.value = picked;
    dp.selection = { text: picked };
    openDuanpingPanel();
}

function hideDpContextMenu() {
    const menu = document.getElementById('dp-ctx-menu');
    if (menu) menu.style.display = 'none';
    dp.ctxMenuOpen = false;
}

/** 找到右键点击位置所在的文本块（段落级别） */
function findTextBlockAtPoint(textEl, x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el || !textEl.contains(el)) return textEl;
    let node = el;
    while (node && node !== textEl) {
        const tag = (node.nodeType === 1 && node.tagName) ? node.tagName.toUpperCase() : '';
        const display = (node.nodeType === 1 && node.tagName) ? getComputedStyle(node).display : '';
        if (['P', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'PRE', 'DIV'].includes(tag) && display && !display.includes('inline')) {
            if (node.textContent && node.textContent.trim()) return node;
        }
        node = node.parentElement;
    }
    return textEl;
}

/** 用 Range 把整个文本块标蓝（微信提取文本的视觉反馈） */
function selectElementText(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
        if (walker.currentNode.textContent && walker.currentNode.textContent.trim()) {
            textNodes.push(walker.currentNode);
        }
    }
    if (!textNodes.length) return null;
    const range = document.createRange();
    range.setStart(textNodes[0], 0);
    const last = textNodes[textNodes.length - 1];
    range.setEnd(last, last.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return range;
}

function openDpContextMenu(x, y, textEl, existing) {
    const menu = document.getElementById('dp-ctx-menu');
    if (!menu) return;
    // 手机端长按触发 contextmenu 时坐标可能缺失，用选区/元素位置兜底
    if (!x && !y) {
        const sel = window.getSelection();
        try {
            const rect = sel && !sel.isCollapsed ? sel.getRangeAt(0).getBoundingClientRect() : textEl.getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.bottom + 6;
        } catch {
            x = window.innerWidth / 2;
            y = window.innerHeight / 2;
        }
    }
    menu.innerHTML = '';
    const add = (label, action, primary) => {
        const item = document.createElement('div');
        item.className = 'dp-ctx-item' + (primary ? ' dp-ctx-primary' : '');
        item.textContent = label;
        item.addEventListener('click', () => {
            hideDpContextMenu();
            handleContextAction(action, textEl, existing, x, y);
        });
        menu.appendChild(item);
    };
    if (existing) {
        add('✎ 给选中文字写段评', 'selection', true);
    } else {
        add('✎ 提取本段写段评', 'extract', true);
    }
    const sep = document.createElement('div');
    sep.className = 'dp-ctx-sep';
    menu.appendChild(sep);
    add(existing ? '📋 复制选中文字' : '📋 复制本段', 'copy');
    menu.style.display = 'block';
    const mw = menu.offsetWidth || 200;
    const mh = menu.offsetHeight || 120;
    menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
    dp.ctxMenuOpen = true;
}

async function handleContextAction(action, textEl, existing, x, y) {
    if (action === 'selection') {
        dp.selection = existing;
        await openDuanpingPanel();
        return;
    }
    if (action === 'extract') {
        const block = findTextBlockAtPoint(textEl, x, y);
        const range = selectElementText(block);
        if (!range) {
            toast('warning', '这一段里没有可提取的文本');
            return;
        }
        const sel = window.getSelection();
        const ctx = getSelectionContext(sel);
        if (ctx) {
            dp.selection = ctx;
            showFloatButton(range.getBoundingClientRect()); // selectionchange 通常会自动弹，这里兜底
            toast('info', '已提取本段，可拖动微调选区，点「✎ 段评」进入');
        } else {
            toast('warning', '未提取到文本');
        }
        return;
    }
    if (action === 'copy') {
        let text = '';
        if (existing) {
            text = existing.text;
        } else {
            const block = findTextBlockAtPoint(textEl, x, y);
            text = block ? block.textContent.trim() : '';
        }
        if (!text) {
            toast('warning', '没有可复制的内容');
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            toast('success', '已复制');
        } catch {
            toast('error', '复制失败，请手动复制');
        }
    }
}

// =====================================================================
// 面板打开 / 模板管理
// =====================================================================

function charCheckboxRow(value, label, avatarFileName) {
    const checked = dp.raterCharIds.includes(value);
    const avatarHtml = avatarFileName
        ? `<img class="dp-char-avatar" src="${esc(avatarUrlFor(avatarFileName))}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'">`
        : '';
    const fallback = `<span class="dp-char-avatar dp-char-fb">${esc(String(label || '?').replace(/（.*/, '').trim().slice(0, 1) || '?')}</span>`;
    return `<label class="dp-char-item${checked ? ' dp-char-checked' : ''}" title="${esc(label)}"><input type="checkbox" value="${value}" ${checked ? 'checked' : ''}>${avatarHtml}${fallback}<span class="dp-char-name">${esc(label)}</span></label>`;
}

async function populateCharacterSelect() {
    const box = document.getElementById('dp-char-list');
    if (!box) return;
    const context = getContext();
    const currentId = context?.characterId ?? -1;
    if (!dp.raterCharIds || !dp.raterCharIds.length) {
        dp.raterCharIds = currentId >= 0 ? [currentId] : [-1];
    }
    let html = '';
    if (currentId >= 0 && characters[currentId]) {
        html += charCheckboxRow(-1, `${characters[currentId].name}（当前）`, characters[currentId].avatar);
    } else {
        html += charCheckboxRow(-1, '当前角色');
    }
    for (let i = 0; i < characters.length; i++) {
        if (i === currentId) continue;
        html += charCheckboxRow(i, characters[i].name, characters[i].avatar);
    }

    box.innerHTML = html;
    box.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const v = cb.value.indexOf('npc:') === 0 ? cb.value : Number(cb.value);
            const set = new Set(dp.raterCharIds);
            if (cb.checked) set.add(v);
            else set.delete(v);
            if (!set.size) set.add(-1);
            dp.raterCharIds = Array.from(set);
            // 同步勾选态（空选时强制回勾当前）
            box.querySelectorAll('input[type="checkbox"]').forEach((x) => {
                x.checked = dp.raterCharIds.includes(x.value.indexOf('npc:') === 0 ? x.value : Number(x.value));
                x.closest('.dp-char-item').classList.toggle('dp-char-checked', x.checked);
            });
        });
    });
}

async function refreshTemplateSelect() {
    const sel = document.getElementById('dp-tpl-select');
    if (!sel) return;
    const settings = getSettings();
    const list = await getTemplateList();
    sel.innerHTML = list.map((t) =>
        `<option value="${esc(t.id)}" ${t.id === settings.activeTemplateId ? 'selected' : ''}>${esc(t.name)}（${esc(t.source)}）</option>`).join('');
}

// =====================================================================
// 自填 API 模型列表 / 角色 @ID 设置
// =====================================================================

async function testApiConnection() {
    const btn = document.getElementById('dp-api-test');
    if (!btn) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
        const ids = await fetchModelList();
        const s = getSettings();
        const sel = document.getElementById('dp-api-model');
        if (sel) {
            sel.innerHTML = ids.map((id) =>
                `<option value="${esc(id)}"${id === s.apiModel ? ' selected' : ''}>${esc(id)}</option>`).join('');
            if (!ids.includes(s.apiModel)) {
                s.apiModel = '';
                saveSettingsDebounced();
            }
        }
        btn.textContent = `✓ 连接成功 · ${ids.length} 个模型`;
    } catch (err) {
        btn.textContent = '✗ 连接失败';
        toast('error', `连接失败：${err?.message || err}`);
        setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2600);
        return;
    }
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 3200);
}

async function refreshModelSelect(autoLoad = true) {
    const sel = document.getElementById('dp-api-model');
    const btn = document.getElementById('dp-api-models');
    if (!sel || !btn) return;
    const s = getSettings();
    const enabled = !!s.apiEnabled && !!(s.apiUrl || '').trim();
    sel.innerHTML = '';
    btn.disabled = !enabled;
    if (!enabled) {
        sel.innerHTML = '<option value="">先填写 API 地址并启用</option>';
        return;
    }
    sel.innerHTML = '<option value="">加载模型列表…</option>';
    if (!autoLoad) {
        // 只回显当前选中模型，不自动请求
        sel.innerHTML = s.apiModel
            ? `<option value="${esc(s.apiModel)}" selected>${esc(s.apiModel)}</option>`
            : '<option value="">选择模型…</option>';
        return;
    }
    try {
        const ids = await fetchModelList();
        sel.innerHTML = ids.map((id) =>
            `<option value="${esc(id)}"${id === s.apiModel ? ' selected' : ''}>${esc(id)}</option>`).join('');
        if (!ids.includes(s.apiModel)) {
            s.apiModel = '';
            saveSettingsDebounced();
        }
        toast('success', `共 ${ids.length} 个可用模型`);
    } catch (err) {
        sel.innerHTML = '<option value="">加载失败</option>';
        toast('error', `模型列表获取失败：${err?.message || err}`);
    }
}

function openIdModal() {
    const modal = document.getElementById('dp-id-modal');
    if (!modal) return;
    const s = getSettings();
    document.getElementById('dp-id-user').value = s.userId || '';
    renderIdList();
    modal.style.display = 'flex';

    // v2.13 布局：CSS 模板移到预览上方，设置区移到预览下方
    try {
        const pw = modal.querySelector('.dp-preview-wrap');
        const adv = modal.querySelector('.dp-advanced');
        const tplSel = document.getElementById('dp-tpl-select');
        const tplRow = tplSel ? tplSel.closest('.dp-row') : null;
        if (pw && tplRow && tplRow.parentNode === modal.querySelector('.dp-body')) {
            pw.parentNode.insertBefore(tplRow, pw);
        }
        if (pw && adv) {
            pw.parentNode.insertBefore(adv, pw.nextSibling);
        }
    } catch (e) { /* noop */ }
}

function renderIdList() {
    const box = document.getElementById('dp-id-list');
    if (!box) return;
    const s = getSettings();
    const seen = new Set();
    const rows = [];
    const pushRow = (name, ch) => {
        if (seen.has(name)) return;
        seen.add(name);
        const manual = (s.charIdMap || {})[name] || '';
        const auto = ch ? (detectEnglishId(ch) || name) : name;
        rows.push(`<div class="dp-id-row">
          <span class="dp-id-name">${esc(name)}</span>
          <span class="dp-id-prefix">@</span>
          <input type="text" class="dp-id-input" data-char="${esc(name)}" value="${esc(manual || '')}" placeholder="${esc(auto)}">
        </div>`);
    };
    characters.forEach((ch) => pushRow(ch.name, ch));
    if (!seen.has(getCurrentCharacter().name)) pushRow(getCurrentCharacter().name, characters[getCurrentCharacter().index] || null);
    box.innerHTML = rows.join('') || '<div class="dp-comment-empty">还没有角色</div>';
}

function saveIdSettings() {
    const s = getSettings();
    s.userId = document.getElementById('dp-id-user').value.trim();
    const map = {};
    document.querySelectorAll('#dp-id-list .dp-id-input').forEach((input) => {
        const name = input.dataset.char;
        const v = input.value.trim();
        if (name && v) map[name] = v;
    });
    s.charIdMap = map;
    saveSettingsDebounced();
    document.getElementById('dp-id-modal').style.display = 'none';
    toast('success', '角色 @ID 已保存');
    renderCommentList();
    renderCard();
}

// =====================================================================
// 存档卡片（localStorage 本地保存，可恢复/删除/导出）
// =====================================================================

const ARCHIVE_KEY = 'jj_duanping_archives';

function loadArchives() {
    try {
        const raw = localStorage.getItem(ARCHIVE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveArchives(list) {
    try {
        localStorage.setItem(ARCHIVE_KEY, JSON.stringify(list));
    } catch (err) {
        console.warn('[晋江段评] 存档保存失败', err);
        toast('error', '存档保存失败（存储空间不足？）');
    }
}

/** 保存当前卡片为一条存档 */
function saveCurrentArchive() {
    const quote = document.getElementById('dp-quote-input')?.value?.trim();
    const s = getSettings();
    if (!quote && !dp.comments.length) {
        toast('warning', '还没有可存档的内容');
        return;
    }
    const arch = {
        id: `a_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        time: new Date().toISOString(),
        quote,
        comments: dp.comments,
        templateId: s.activeTemplateId,
        bookTitle: s.bookTitle || '',
        chapterText: s.chapterText || '',
        watermarkText: s.watermarkText || '',
        quoteSize: s.quoteSize ?? 15,
        quoteLh: s.quoteLh ?? 1.6,
        quoteLs: s.quoteLs ?? 0,
        cardWidth: s.cardWidth || 0,
        captureEngine: s.captureEngine || 'auto',
        nightMode: !!s.nightMode,
        stickers: (s.stickers || []).map((x) => ({ ...x })),
    };
    const list = loadArchives();
    list.unshift(arch);
    saveArchives(list);
    toast('success', `已存档 ${dp.comments.length} 条评论的卡片`);
}

function fmtTime(iso) {
    try {
        const d = new Date(iso);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch {
        return '';
    }
}

function renderArchiveList() {
    const box = document.getElementById('dp-archive-list');
    if (!box) return;
    const list = loadArchives();
    if (!list.length) {
        box.innerHTML = '<div class="dp-comment-empty">还没有存档卡片。生成段评后点「💾 存档卡片」即可保存。</div>';
        return;
    }
    box.innerHTML = list.map((a) => {
        const quote = (a.quote || '').slice(0, 26) || '（无原文）';
        const n = (a.comments || []).length;
        return `<div class="dp-arch-row">
          <div class="dp-arch-info">
            <div class="dp-arch-time">${esc(fmtTime(a.time))} · ${n} 条评论</div>
            <div class="dp-arch-quote">${esc(quote)}${(a.quote || '').length > 26 ? '…' : ''}</div>
          </div>
          <div class="dp-arch-actions">
            <button type="button" class="dp-btn dp-btn-sm dp-arch-restore" data-id="${esc(a.id)}">恢复</button>
            <button type="button" class="dp-btn dp-btn-sm dp-btn-danger dp-arch-del" data-id="${esc(a.id)}">删除</button>
          </div>
        </div>`;
    }).join('');
    box.querySelectorAll('.dp-arch-restore').forEach((btn) => {
        btn.addEventListener('click', () => restoreArchive(btn.dataset.id));
    });
    box.querySelectorAll('.dp-arch-del').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const list2 = loadArchives().filter((x) => x.id !== id);
            saveArchives(list2);
            renderArchiveList();
            toast('success', '存档已删除');
        });
    });
}

function openArchiveModal() {
    const modal = document.getElementById('dp-archive-modal');
    if (!modal) return;
    renderArchiveList();
    modal.style.display = 'flex';
}

/** 恢复存档：填充原文/评论/模板/高级设置并重新渲染 */
async function restoreArchive(id) {
    const list = loadArchives();
    const a = list.find((x) => x.id === id);
    if (!a) return;
    const s = getSettings();
    document.getElementById('dp-quote-input').value = a.quote || '';
    dp.comments = (a.comments || []).map((c) => ({ ...c }));
    dp.selection = null;
    if (a.templateId) s.activeTemplateId = a.templateId;
    if (a.bookTitle !== undefined) s.bookTitle = a.bookTitle;
    if (a.chapterText !== undefined) s.chapterText = a.chapterText;
    if (a.watermarkText !== undefined) s.watermarkText = a.watermarkText;
    if (a.quoteSize) s.quoteSize = a.quoteSize;
    if (a.quoteLh) s.quoteLh = a.quoteLh;
    if (a.quoteLs !== undefined) s.quoteLs = a.quoteLs;
    if (a.cardWidth !== undefined) s.cardWidth = a.cardWidth;
    if (a.captureEngine) s.captureEngine = a.captureEngine;
    if (a.nightMode !== undefined) s.nightMode = !!a.nightMode;
    if (a.stickers !== undefined) s.stickers = (a.stickers || []).map((x) => ({ ...x }));
    saveSettingsDebounced();
    document.getElementById('dp-archive-modal').style.display = 'none';
    await populateCharacterSelect();
    await refreshTemplateSelect();
    if (typeof syncNightBtn === 'function') syncNightBtn();
    if (typeof syncWidthSlider === 'function') syncWidthSlider();
    await renderCommentList();
    await renderCard();
    toast('success', '存档已恢复');
}

/** 导出全部存档为 JSON 文件 */
function exportArchives() {
    const list = loadArchives();
    if (!list.length) {
        toast('warning', '还没有存档可导出');
        return;
    }
    const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `jj-duanping-archives-${timestamp()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
    }, 500);
    toast('success', `已导出 ${list.length} 条存档`);
}

// =====================================================================
// 贴纸弹窗：emoji / 颜文字 / 图片贴纸
// =====================================================================

function openStickerModal() {
    const modal = document.getElementById('dp-sticker-modal');
    if (!modal) return;
    // emoji 网格
    const emojiBox = document.getElementById('dp-stk-emoji');
    if (emojiBox && !emojiBox.dataset.built) {
        emojiBox.dataset.built = '1';
        emojiBox.innerHTML = EMOJI_STICKERS.map((e) =>
            `<button type="button" class="dp-stk-item" data-content="${esc(e)}" title="添加到卡片">${e}</button>`).join('');
        emojiBox.querySelectorAll('.dp-stk-item').forEach((btn) => {
            btn.addEventListener('click', () => addSticker({ type: 'emoji', content: btn.dataset.content, size: 40 }));
        });
    }
    // 颜文字网格
    const kaoBox = document.getElementById('dp-stk-kaomoji');
    if (kaoBox && !kaoBox.dataset.built) {
        kaoBox.dataset.built = '1';
        kaoBox.innerHTML = KAOMOJI_STICKERS.map((k) =>
            `<button type="button" class="dp-stk-item dp-stk-item-kao" data-content="${esc(k)}" title="添加到卡片">${k}</button>`).join('');
        kaoBox.querySelectorAll('.dp-stk-item').forEach((btn) => {
            btn.addEventListener('click', () => addSticker({ type: 'kaomoji', content: btn.dataset.content, size: 22 }));
        });
    }
    renderStickerImgLib();
    renderStickerManageList();
    modal.style.display = 'flex';
}

function renderStickerImgLib() {
    const box = document.getElementById('dp-stk-img-lib');
    const empty = document.getElementById('dp-stk-img-empty');
    if (!box) return;
    const lib = stickerImageLib();
    if (!lib.length) {
        box.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';
    box.innerHTML = lib.map((it) =>
        `<button type="button" class="dp-stk-item dp-stk-item-img" data-id="${esc(it.id)}" title="添加到卡片"><img src="${esc(it.data)}" draggable="false"></button>`).join('');
    box.querySelectorAll('.dp-stk-item-img').forEach((btn) => {
        btn.addEventListener('click', () => {
            const it = stickerImageLib().find((x) => x.id === btn.dataset.id);
            if (it) addSticker({ type: 'img', content: it.data, width: 90 });
        });
    });
}

async function openDuanpingPanel() {
    const settings = getSettings();
    const modal = document.getElementById('dp-modal');
    if (!modal) return;
    // 内联样式兜底：无论任何 CSS/其他扩展怎么覆盖，面板都强制铺满视口（防止“面板飘出界面/显示不出来”）。
    // 必须用视口单位显式宽高：fork 给 <html> 设了 transform，fixed 元素包含块变成 <html> 盒子，
    // 而移动端 body{position:fixed} 让 <html> 高度坍缩为 0，单靠 top/bottom 拉伸会得到高度 0 的隐形面板。
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.right = '0';
    modal.style.bottom = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.height = '100dvh';
    modal.style.zIndex = '2147483647';
    modal.style.display = 'flex';

    // 选区：新选区（不同文本/不同消息/不同作者）才覆盖输入框；
    // 同一选区重开面板则保留用户手动编辑的内容；输入框为空时始终填充。
    const quoteInput = document.getElementById('dp-quote-input');
    if (dp.selection && dp.selection.text) {
        const cur = dp.selection;
        const last = dp.lastFilled;
        const isNew = !last
            || last.mesIndex !== cur.mesIndex
            || last.text !== cur.text
            || (last.author || '') !== (cur.author || '');
        if (isNew || !quoteInput.value) {
            quoteInput.value = compactNewlines(cur.text);
            dp.lastFilled = { text: cur.text, mesIndex: cur.mesIndex, author: cur.author || '' };
        }
    }

    await populateCharacterSelect();
    await refreshTemplateSelect();
    renderCommentList();

    // 填充设置项
    document.getElementById('dp-set-title').value = settings.bookTitle || '';
    document.getElementById('dp-set-chapter').value = settings.chapterText || '';
    document.getElementById('dp-set-watermark').value = settings.watermarkText || '';
    document.getElementById('dp-set-qsize').value = settings.quoteSize ?? 15;
    document.getElementById('dp-set-qlh').value = settings.quoteLh ?? 1.6;
    document.getElementById('dp-set-qls').value = settings.quoteLs ?? 0;
    document.getElementById('dp-set-prompt').value = settings.promptTemplate;
    document.getElementById('dp-set-engine').value = settings.captureEngine || 'auto';
    document.getElementById('dp-set-launcher').value = String(!!settings.showLauncher);
    const ceEl = document.getElementById('dp-collage-enable');
    if (ceEl) ceEl.checked = !!settings.collageEnabled;
    document.getElementById('dp-set-width').value = settings.cardWidth || '';
    document.getElementById('dp-set-userid').value = settings.userId || '';
    const bgInp = document.getElementById('dp-set-bg');
    if (bgInp) bgInp.value = (settings.bgImage || '').startsWith('data:') ? '已上传图片（base64）' : (settings.bgImage || '');
    const tcInp = document.getElementById('dp-set-textcolor');
    if (tcInp) tcInp.value = settings.textColor || '#ffffff';
    const qsInp = document.getElementById('dp-set-bgqsize');
    if (qsInp) qsInp.value = settings.bgQuoteSize ?? 22;
    const qlInp = document.getElementById('dp-set-bgqlh');
    if (qlInp) qlInp.value = settings.bgQuoteLh ?? 1.8;
    const fuInp = document.getElementById('dp-set-fonturl');
    if (fuInp) fuInp.value = settings.fontUrl || '';
    renderFontLib();
    document.getElementById('dp-api-enable').checked = !!settings.apiEnabled;
    document.getElementById('dp-api-url').value = settings.apiUrl || '';
    document.getElementById('dp-api-key').value = settings.apiKey || '';
    refreshModelSelect(false);
    if (typeof syncWidthSlider === 'function') syncWidthSlider();
    if (typeof syncNightBtn === 'function') syncNightBtn();

    await renderCard();
    hideFloatButton();
}

async function refreshTemplateManager() {
    const listBox = document.getElementById('dp-tpl-list');
    if (!listBox) return;
    const settings = getSettings();
    const list = await getTemplateList();
    listBox.innerHTML = list.map((t) => {
        const isActive = t.id === settings.activeTemplateId;
        return `
      <div class="dp-tpl-row ${isActive ? 'dp-tpl-active' : ''}">
        <div class="dp-tpl-info">
          <span class="dp-tpl-name">${esc(t.name)}</span>
          <span class="dp-tpl-badge ${t.builtin ? 'dp-badge-builtin' : 'dp-badge-custom'}">${t.builtin ? '内置' : '自定义'}</span>
          ${isActive ? '<span class="dp-tpl-badge dp-badge-active">使用中</span>' : ''}
        </div>
        <div class="dp-tpl-actions">
          <button type="button" class="dp-btn dp-btn-sm dp-tpl-apply" data-id="${esc(t.id)}">应用</button>
          ${t.builtin
            ? `<button type="button" class="dp-btn dp-btn-sm dp-tpl-fork" data-id="${esc(t.id)}" data-name="${esc(t.name)}">建副本</button>`
            : `<button type="button" class="dp-btn dp-btn-sm dp-tpl-edit" data-id="${esc(t.id)}">编辑</button>
               <button type="button" class="dp-btn dp-btn-sm dp-tpl-export" data-id="${esc(t.id)}" data-name="${esc(t.name)}">导出</button>
               <button type="button" class="dp-btn dp-btn-sm dp-btn-danger dp-tpl-del" data-id="${esc(t.id)}">删除</button>`}
        </div>
      </div>`;
    }).join('');

    // 应用
    listBox.querySelectorAll('.dp-tpl-apply').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const settings = getSettings();
            settings.activeTemplateId = btn.dataset.id;
            saveSettingsDebounced();
            await refreshTemplateManager();
            await refreshTemplateSelect();
            await renderCard();
            toast('success', '模板已应用');
        });
    });
    // 内置建副本 → 直接成为自定义并应用（连同该模板的评论模块样式）
    listBox.querySelectorAll('.dp-tpl-fork').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const settings = getSettings();
            const id = btn.dataset.id;
            const css = await resolveTemplateCss(id);
            const commentCss = await resolveTemplateComments(id);
            const newId = createCustomTemplate(`${btn.dataset.name || '模板'} 副本`, css, commentCss);
            settings.activeTemplateId = newId;
            saveSettingsDebounced();
            await refreshTemplateManager();
            await refreshTemplateSelect();
            await renderCard();
            toast('success', '已创建副本并应用');
        });
    });
    // 编辑
    listBox.querySelectorAll('.dp-tpl-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
            const t = (settings.customTemplates || []).find((x) => x.id === btn.dataset.id);
            if (t) openTemplateEditor(t);
        });
    });
    // 导出
    listBox.querySelectorAll('.dp-tpl-export').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const t = (settings.customTemplates || []).find((x) => x.id === btn.dataset.id);
            if (!t) return;
            exportTemplateJson(t);
        });
    });
    // 删除
    listBox.querySelectorAll('.dp-tpl-del').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!confirm('确认删除该模板？')) return;
            deleteCustomTemplate(btn.dataset.id);
            refreshTemplateManager();
            refreshTemplateSelect();
            renderCard();
        });
    });
}

function exportTemplateJson(t) {
    const blob = new Blob([JSON.stringify({ name: t.name, css: t.css, comments: t.comments || '' }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `${t.name}.json`);
    toast('success', `已导出「${t.name}.json」`);
}

let templateEditorTargetId = null;

function openTemplateEditor(template) {
    const editor = document.getElementById('dp-tpl-editor');
    if (!editor) return;
    editor.style.display = 'block';
    templateEditorTargetId = template ? template.id : null;
    document.getElementById('dp-tpl-name').value = template ? template.name : '';
    document.getElementById('dp-tpl-id').value = template ? template.id : '(新建)';
    document.getElementById('dp-tpl-css').value = template ? template.css : '';
    document.getElementById('dp-tpl-css-comments').value = template ? (template.comments || '') : '';
}

async function saveTemplateEditor() {
    const name = document.getElementById('dp-tpl-name').value.trim();
    const css = document.getElementById('dp-tpl-css').value;
    const commentsCss = document.getElementById('dp-tpl-css-comments').value;
    if (!name) {
        toast('warning', '请填写模板名称');
        return;
    }
    if (templateEditorTargetId) {
        updateCustomTemplate(templateEditorTargetId, name, css, commentsCss);
    } else {
        const id = createCustomTemplate(name, css, commentsCss);
        // 新模板自动设为当前模板，立即预览
        getSettings().activeTemplateId = id;
        saveSettingsDebounced();
    }
    document.getElementById('dp-tpl-editor').style.display = 'none';
    invalidateTemplateCache();
    await refreshTemplateManager();
    await refreshTemplateSelect();
    await renderCard();
    toast('success', '模板已保存');
}

async function openTemplateManager() {
    const modal = document.getElementById('dp-tpl-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    await refreshTemplateManager();
}

// =====================================================================
// 指令
// =====================================================================

async function slashDuanping(_args, value) {
    const text = Array.isArray(value) ? value.join(' ') : String(value ?? '');
    const quoteInput = document.getElementById('dp-quote-input');
    if (text && quoteInput) {
        quoteInput.value = compactNewlines(text);
        dp.selection = dp.selection || { text, mesIndex: 0, author: '' };
        dp.selection.text = text;
    } else {
        const sel = window.getSelection();
        const context = getSelectionContext(sel);
        if (context) {
            dp.selection = context;
        }
    }
    await openDuanpingPanel();
}

async function slashTemplateManager() {
    await openTemplateManager();
}

// =====================================================================
// 打孔拼贴诗（背景图模板 · 在背景图上逐字/逐词粘贴可裁剪、可旋转的纸片文字）
// =====================================================================
const COLLAGE_SHAPES = [
    { id: 'rect', label: '矩形', css: '0' },
    { id: 'round', label: '圆角', css: '12%' },
    { id: 'circle', label: '圆形', css: '999px' },
    { id: 'ellipse', label: '椭圆', css: '50%' },
];

const collageState = { open: false, sel: -1, drag: null, scale: 1 };
let collageImgCache = null;

/** 加载背景图并缓存自然尺寸（1:1 输出依据） */
async function collageEnsureImage() {
    const s = getSettings();
    if (!s.bgImage) return null;
    if (collageImgCache && collageImgCache.src === s.bgImage && collageImgCache.img) {
        if (!s.collageImgW) {
            s.collageImgW = collageImgCache.img.naturalWidth;
            s.collageImgH = collageImgCache.img.naturalHeight;
            saveSettingsDebounced();
        }
        return collageImgCache;
    }
    try {
        const img = new Image();
        await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = s.bgImage;
        });
        collageImgCache = { src: s.bgImage, img };
        if (img.naturalWidth > 0) {
            s.collageImgW = img.naturalWidth;
            s.collageImgH = img.naturalHeight;
            renderCard(); // 换背景图后按新尺寸重排纸片，避免旧尺寸缓存导致纸片错位
            saveSettingsDebounced();
        }
        return collageImgCache;
    } catch (e) {
        console.warn('[晋江段评] 拼贴背景图加载失败', s.bgImage ? s.bgImage.slice(0, 40) : '(空)', s.bgImage ? s.bgImage.length : 0);
        return null;
    }
}

function collageImgSize() {
    const s = getSettings();
    if (s.collageImgW > 0 && s.collageImgH > 0) return { W: s.collageImgW, H: s.collageImgH };
    return null;
}

function collageFontStack() {
    const s = getSettings();
    const fam = s.fontFamily || 'dp-font-custom';
    return `"${fam}", "Kaiti SC", "KaiTi", "STKaiti", "SimSun", serif`;
}

function collageShapeCss(shape) {
    const hit = COLLAGE_SHAPES.find((x) => x.id === shape);
    return hit ? hit.css : '0';
}

async function openCollageEditor() {
    const s = getSettings();
    const box = document.getElementById('dp-collage-inline');
    if (!box) return;
    box.style.display = 'block';
    collageState.open = true;
    const openBtn = document.getElementById('dp-btn-collage');
    if (openBtn) openBtn.textContent = '✂ 收起拼贴诗编辑器';
    try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* noop */ }
    // 主文档注入 @font-face，画布才能使用所选字体
    try {
        const faceCss = await loadFontCssText(s);
        if (faceCss) {
            let st = document.getElementById('dp-collage-font-face');
            if (!st) {
                st = document.createElement('style');
                st.id = 'dp-collage-font-face';
                document.head.appendChild(st);
            }
            st.textContent = faceCss;
        }
    } catch (e) { /* noop */ }
    const bgcolor = document.getElementById('dp-collage-bgcolor');
    if (bgcolor) bgcolor.value = s.collageBgColor || '#000000';
    const inp = document.getElementById('dp-collage-input');
    if (inp) inp.value = '';
    collageState.sel = -1;
    collageState.drag = null;
    collageRenderControls();
    ['dp-collage-enable', 'dp-collage-enable2'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!s.collageEnabled;
    });
    await collageEnsureImage();
    const empty = document.getElementById('dp-collage-empty');
    if (empty) empty.style.display = s.bgImage ? 'none' : 'block';
    renderCollageCanvas();
    if (!s.bgImage) {
        toast('info', '尚未设置背景图——将用纯色画布（可点右下「画布底色」选色）；也可先在「设置」里粘贴/上传背景图做 1:1 拼贴');
    }
}

function closeCollageEditor(apply) {
    const box = document.getElementById('dp-collage-inline');
    if (box) box.style.display = 'none';
    collageState.open = false;
    collageState.sel = -1;
    collageState.drag = null;
    const openBtn = document.getElementById('dp-btn-collage');
    if (openBtn) openBtn.textContent = '✂ 拼贴诗编辑器';
    if (apply !== false) renderCard();
}

function collageRenderControls() {
    const s = getSettings();
    const words = s.collageWords || [];
    const i = collageState.sel;
    const w = i >= 0 && i < words.length ? words[i] : null;
    const ctl = document.getElementById('dp-collage-ctl');
    if (ctl) ctl.style.opacity = w ? '1' : '0.4';
    const del = document.getElementById('dp-collage-del');
    if (del) del.disabled = !w;
    if (w) {
        const shape = document.getElementById('dp-collage-shape');
        if (shape) shape.value = w.shape || 'round';
        const bg = document.getElementById('dp-collage-bg');
        if (bg) bg.value = w.bg || '#f5eedd';
        const fg = document.getElementById('dp-collage-fg');
        if (fg) fg.value = w.fg || '#333333';
        const size = document.getElementById('dp-collage-size');
        if (size) size.value = String(Math.max(8, Number(w.size) || 20));
        const rot = document.getElementById('dp-collage-rot');
        if (rot) rot.value = String(Math.round(Number(w.rot) || 0));
        const ag = document.getElementById('dp-collage-align');
        if (ag) {
            const ah = w.ah || 'center';
            const av = w.av || 'middle';
            ag.querySelectorAll('.dp-align-cell').forEach((b) => {
                b.classList.toggle('on', b.dataset.a === ah && b.dataset.b === av);
            });
        }
    }
}

function roundRectPath(ctx, x, y, w, h, r) {
    if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x, y, w, h, r);
        return;
    }
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

function collageShapeRadius(shape, bw, bh) {
    const m = Math.min(bw, bh);
    switch (shape) {
        case 'circle': return m / 2;
        case 'ellipse': return -1; // 全椭圆
        case 'round': return m * 0.12;
        default: return 0;
    }
}

function drawCollageWord(ctx, w) {
    const scale = collageState.scale;
    const bw = w.w * scale;
    const bh = w.h * scale;
    const cx = (w.x + w.w / 2) * scale;
    const cy = (w.y + w.h / 2) * scale;
    const rot = ((Number(w.rot) || 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.fillStyle = w.bg || '#f5eedd';
    const rad = collageShapeRadius(w.shape, bw, bh);
    if (rad < 0) {
        ctx.beginPath();
        ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
        ctx.fill();
    } else {
        roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, rad);
        ctx.fill();
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // 材质纹理（canvas 与下载 CSS 材质逐参数同参：渐变 + 重复线/点，保证预览=下载）
    const pm2 = (w.paper || 'plain');
    if (pm2 === 'custom') {
        if (collagePaperImgObj) {
            ctx.save();
            ctx.beginPath();
            if (rad < 0) ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
            else roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, rad);
            ctx.clip();
            ctx.drawImage(collagePaperImgObj, -bw / 2, -bh / 2, bw, bh);
            const _ts = getSettings();
            const _tc = (_ts.collagePaperTint || '').trim();
            const _tv = Number(_ts.collagePaperTintStrength) || 0;
            if (_tc && _tv > 0) {
                ctx.globalAlpha = Math.min(1, _tv / 100);
                ctx.fillStyle = _tc;
                ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
                ctx.globalAlpha = 1;
            }
            ctx.restore();
        }
    } else if (pm2 === 'kraft' || pm2 === 'craft' || pm2 === 'xuan' || pm2 === 'news' || pm2 === 'lined' || pm2 === 'grid') {
        ctx.save();
        ctx.beginPath();
        if (rad < 0) ctx.ellipse(0, 0, bw / 2, bh / 2, 0, 0, Math.PI * 2);
        else roundRectPath(ctx, -bw / 2, -bh / 2, bw, bh, rad);
        ctx.clip();
        if (pm2 === 'kraft' || pm2 === 'craft') {
            const g2 = ctx.createLinearGradient(-bw / 2, bh / 2, bw / 2, -bh / 2);
            if (pm2 === 'kraft') { g2.addColorStop(0, 'rgba(190,150,90,.4)'); g2.addColorStop(0.5, 'rgba(160,120,70,.18)'); g2.addColorStop(1, 'rgba(130,95,55,.34)'); }
            else { g2.addColorStop(0, 'rgba(165,110,55,.44)'); g2.addColorStop(0.55, 'rgba(125,80,38,.22)'); g2.addColorStop(1, 'rgba(100,62,28,.38)'); }
            ctx.fillStyle = g2;
            ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
            if (pm2 === 'kraft') {
                ctx.strokeStyle = 'rgba(120,90,50,.12)';
                ctx.lineWidth = 1;
                const step = 4 * scale;
                for (let yy = -bh / 2; yy < bh / 2; yy += step) { ctx.beginPath(); ctx.moveTo(-bw / 2, yy); ctx.lineTo(bw / 2, yy); ctx.stroke(); }
            } else {
                ctx.strokeStyle = 'rgba(120,80,40,.12)';
                ctx.lineWidth = 2;
                const step = 7 * scale;
                for (let xx = -bw / 2; xx < bw / 2; xx += step) { ctx.beginPath(); ctx.moveTo(xx, -bh / 2); ctx.lineTo(xx, bh / 2); ctx.stroke(); }
            }
        } else if (pm2 === 'xuan') {
            ctx.fillStyle = 'rgba(160,130,90,.32)';
            const step = 6 * scale;
            const r2 = Math.max(0.4, 0.8 * scale);
            for (let yy = -bh / 2; yy < bh / 2; yy += step) for (let xx = -bw / 2; xx < bw / 2; xx += step) { ctx.beginPath(); ctx.arc(xx, yy, r2, 0, Math.PI * 2); ctx.fill(); }
        } else if (pm2 === 'news') {
            ctx.strokeStyle = 'rgba(80,80,80,.18)';
            ctx.lineWidth = 1;
            const step = 10 * scale;
            for (let yy = -bh / 2; yy < bh / 2; yy += step) { ctx.beginPath(); ctx.moveTo(-bw / 2, yy); ctx.lineTo(bw / 2, yy); ctx.stroke(); }
        } else if (pm2 === 'lined') {
            ctx.strokeStyle = 'rgba(90,140,220,.4)';
            ctx.lineWidth = 1;
            const step = 13 * scale;
            for (let yy = -bh / 2; yy < bh / 2; yy += step) { ctx.beginPath(); ctx.moveTo(-bw / 2, yy); ctx.lineTo(bw / 2, yy); ctx.stroke(); }
        } else if (pm2 === 'grid') {
            ctx.strokeStyle = 'rgba(90,140,220,.34)';
            ctx.lineWidth = 1;
            const step = 15 * scale;
            for (let yy = -bh / 2; yy < bh / 2; yy += step) { ctx.beginPath(); ctx.moveTo(-bw / 2, yy); ctx.lineTo(bw / 2, yy); ctx.stroke(); }
            for (let xx = -bw / 2; xx < bw / 2; xx += step) { ctx.beginPath(); ctx.moveTo(xx, -bh / 2); ctx.lineTo(xx, bh / 2); ctx.stroke(); }
        }
        ctx.restore();
    }
    ctx.fillStyle = w.fg || '#333333';
    ctx.font = `${Math.max(4, Math.round((Number(w.size) || 20) * scale * 10) / 10)}px ${collageFontStack()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ah = w.ah || 'center';
    const av = w.av || 'middle';
    const pad = 6 * scale;
    let ddx = 0, ddy = 0;
    if (ah === 'left') ddx = -bw / 2 + pad;
    else if (ah === 'right') ddx = bw / 2 - pad;
    if (av === 'top') ddy = -bh / 2 + pad;
    else if (av === 'bottom') ddy = bh / 2 - pad;
    ctx.fillText(w.text || '', ddx, ddy + 1);
    ctx.restore();
}

function drawCollageSelection(ctx, w) {
    const scale = collageState.scale;
    const cx = (w.x + w.w / 2) * scale;
    const cy = (w.y + w.h / 2) * scale;
    const hw = (w.w / 2) * scale;
    const hh = (w.h / 2) * scale;
    const rad = ((Number(w.rot) || 0) * Math.PI) / 180;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rad);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#e33';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-hw, -hh, hw * 2, hh * 2);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(0, -hh - 18, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#e33';
    ctx.fill();
    ctx.fillRect(hw - 7, hh - 7, 14, 14);
    ctx.restore();
}

/** 逐字符强制加载拼贴字体全部分片（解决 unicode-range 分片字体"只生效几个字"） */
async function collageLoadAllFonts() {
    const s = getSettings();
    const fam = String(s.fontFamily || 'dp-font-custom').replace(/["']/g, '');
    if (!fam || !document.fonts || !document.fonts.load) return;
    const chars = new Set();
    (s.collageWords || []).forEach((w) => String(w.text || '').split('').forEach((c) => chars.add(c)));
    if (!chars.size) return;
    try {
        await Promise.all([...chars].map((c) => document.fonts.load(`32px "${fam}"`, c).catch(() => null)));
        await Promise.race([document.fonts.ready, new Promise((res) => setTimeout(res, 800))]);
    } catch (e) { /* noop */ }
}

async function renderCollageCanvas() {
    await collageLoadAllFonts();
    const canvas = document.getElementById('dp-collage-canvas');
    if (!canvas) return;
    const s = getSettings();
    const words = s.collageWords || [];
    const size = collageImgSize();
    const W = size ? size.W : 1080;
    const H = size ? size.H : 1470;
    const box = document.getElementById('dp-collage-canvas-box');
    const availW = box ? Math.max(180, box.clientWidth - 8) : 600;
    const scale = Math.min(1, availW / W, 460 / H);
    collageState.scale = scale;
    canvas.width = Math.max(8, Math.round(W * scale));
    canvas.height = Math.max(8, Math.round(H * scale));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = await collageEnsureImage();
    if (img) {
        ctx.drawImage(img.img, 0, 0, canvas.width, canvas.height);
    } else {
        ctx.fillStyle = s.collageBgColor || '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // 确保所选字体已加载再绘制文字（否则 canvas 会用回退字体，出现字体不生效/部分不生效）
    const famStr = String(s.fontFamily || 'dp-font-custom').replace(/["']/g, '');
    if (famStr && document.fonts && document.fonts.load) {
        try {
            await Promise.race([
                Promise.all([document.fonts.load(`16px "${famStr}"`), document.fonts.load(`32px "${famStr}"`)]),
                new Promise((res) => setTimeout(res, 1500))
            ]);
        } catch (e) { /* noop */ }
    }
    words.forEach((w) => drawCollageWord(ctx, w));
    if (collageState.sel >= 0 && collageState.sel < words.length) drawCollageSelection(ctx, words[collageState.sel]);
    const empty = document.getElementById('dp-collage-empty');
    if (empty) empty.style.display = s.bgImage ? 'none' : 'block';
}

function pointInRotatedRect(px, py, cx, cy, w, h, rotDeg) {
    const rad = (rotDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = px - cx;
    const dy = py - cy;
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

function bindCollageCanvas() {
    const canvas = document.getElementById('dp-collage-canvas');
    if (!canvas || canvas._dpCollageBound) return;
    canvas._dpCollageBound = true;
    const toImg = (e) => {
        const rect = canvas.getBoundingClientRect();
        const scale = collageState.scale || 1;
        return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
    };
    const toCss = (e) => {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        try { canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
        const s = getSettings();
        const words = s.collageWords || [];
        const p = toImg(e);
        const css = toCss(e);
        const scale = collageState.scale || 1;
        if (collageState.sel >= 0 && collageState.sel < words.length) {
            const w = words[collageState.sel];
            const cx = (w.x + w.w / 2) * scale;
            const cy = (w.y + w.h / 2) * scale;
            const halfW = (w.w / 2) * scale;
            const halfH = (w.h / 2) * scale;
            // 旋转柄（顶部外侧）
            if (Math.hypot(css.x - cx, css.y - (cy - halfH - 18)) <= 14) {
                collageState.drag = { type: 'rotate', i: collageState.sel };
                return;
            }
            // 缩放/裁剪柄（右下角，随旋转）
            const rad = ((Number(w.rot) || 0) * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const rcx = cx + (halfW * cos - halfH * sin);
            const rcy = cy + (halfW * sin + halfH * cos);
            if (Math.hypot(css.x - rcx, css.y - rcy) <= 16) {
                collageState.drag = { type: 'resize', i: collageState.sel, startX: p.x, startY: p.y, startW: w.w, startH: w.h };
                return;
            }
        }
        for (let i = words.length - 1; i >= 0; i--) {
            const w = words[i];
            const cx = w.x + w.w / 2;
            const cy = w.y + w.h / 2;
            if (pointInRotatedRect(p.x, p.y, cx, cy, w.w, w.h, Number(w.rot) || 0)) {
                collageState.sel = i;
                collageState.drag = { type: 'move', i, startX: p.x, startY: p.y, origX: w.x, origY: w.y };
                collageRenderControls();
                renderCollageCanvas();
                return;
            }
        }
        collageState.sel = -1;
        collageState.drag = null;
        collageRenderControls();
        renderCollageCanvas();
    });
    canvas.addEventListener('pointermove', (e) => {
        const d = collageState.drag;
        if (!d) return;
        e.preventDefault();
        const s = getSettings();
        const words = s.collageWords || [];
        const w = words[d.i];
        if (!w) return;
        const p = toImg(e);
        if (d.type === 'move') {
            const size = collageImgSize(); const CW = size ? size.W : 1080; const CH = size ? size.H : 1470; w.x = Math.min(Math.max(0, Math.round(d.origX + (p.x - d.startX))), Math.max(0, CW - w.w));
            w.y = Math.min(Math.max(0, Math.round(d.origY + (p.y - d.startY))), Math.max(0, CH - w.h));
        } else if (d.type === 'resize') {
            const size = collageImgSize(); const CW = size ? size.W : 1080; const CH = size ? size.H : 1470; w.w = Math.min(Math.max(24, Math.round(d.startW + (p.x - d.startX))), Math.max(24, CW - w.x));
            w.h = Math.min(Math.max(24, Math.round(d.startH + (p.y - d.startY))), Math.max(24, CH - w.y));
        } else if (d.type === 'rotate') {
            const scale = collageState.scale || 1;
            const css = toCss(e);
            const cx = (w.x + w.w / 2) * scale;
            const cy = (w.y + w.h / 2) * scale;
            w.rot = Math.round(Math.atan2(css.y - cy, css.x - cx) * 180 / Math.PI);
        }
        saveSettingsDebounced();
        collageRenderControls();
        renderCollageCanvas();
    });
    const stopDrag = () => { collageState.drag = null; };
    canvas.addEventListener('pointerup', stopDrag);
    canvas.addEventListener('pointercancel', stopDrag);
    canvas.addEventListener('dblclick', (e) => {
        const s = getSettings();
        const words = s.collageWords || [];
        if (collageState.sel < 0 || !words[collageState.sel]) return;
        const w = words[collageState.sel];
        const txt = prompt('修改纸片文字：', w.text);
        if (txt !== null) {
            w.text = String(txt).trim() || w.text;
            saveSettingsDebounced();
            renderCollageCanvas();
        }
    });
}

/** 找中心附近不与已有词条重叠的位置：第一个词完全居中，后续词自动微偏移避让 */
function collageFindSpot(W, H, bw, bh, words) {
    const cx = Math.max(4, (W - bw) / 2);
    const cy = Math.max(4, (H - bh) / 2);
    const list = words || [];
    const overlap = (x, y) => list.some((o) =>
        Math.abs(o.x + o.w / 2 - (x + bw / 2)) < (o.w + bw) / 2 &&
        Math.abs(o.y + o.h / 2 - (y + bh / 2)) < (o.h + bh) / 2
    );
    if (!overlap(cx, cy)) return { x: Math.round(cx), y: Math.round(cy) };
    for (let i = 0; i < 60; i++) {
        const jx = Math.round((Math.random() * 2 - 1) * Math.min(260, W * 0.3));
        const jy = Math.round((Math.random() * 2 - 1) * Math.min(260, H * 0.3));
        const x = Math.round(Math.max(4, Math.min(W - bw - 4, cx + jx)));
        const y = Math.round(Math.max(4, Math.min(H - bh - 4, cy + jy)));
        if (!overlap(x, y)) return { x, y };
    }
    for (let i = 0; i < 160; i++) {
        const x = Math.round(Math.max(4, Math.random() * (W - bw - 8)));
        const y = Math.round(Math.max(4, Math.random() * (H - bh - 8)));
        if (!overlap(x, y)) return { x, y };
    }
    return { x: Math.round(cx), y: Math.round(cy) };
}

function collageAddWord(text) {
    const s = getSettings();
    const t = String(text || '').trim();
    const inp = document.getElementById('dp-collage-input');
    if (inp) inp.value = '';
    if (!t) {
        toast('warning', '请先输入文字');
        return;
    }
    const size = collageImgSize();
    const W = size ? size.W : 1080;
    const H = size ? size.H : 1470;
    const chars = Array.from(t).length;
    const isShort = chars <= 2;
    const bw = Math.max(48, Math.round(chars * (isShort ? 92 : 62)));
    const bh = isShort ? 92 : 66;
    // 新词条默认完全居中（若中心已被占用则自动微偏移避让，不遮挡已有词条），参数继承工具区当前值
    const spot = collageFindSpot(W, H, bw, bh, s.collageWords || []);
    const word = {
        id: `cw_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
        text: t,
        x: spot.x,
        y: spot.y,
        w: bw,
        h: bh,
        rot: Math.max(-360, Math.min(360, Number((document.getElementById('dp-collage-rot') || {}).value) || 0)),
        shape: (document.getElementById('dp-collage-shape') || {}).value || 'round',
        ah: 'center',
        av: 'middle',
        bg: (document.getElementById('dp-collage-bg') || {}).value || '#f5eedd',
        fg: (document.getElementById('dp-collage-fg') || {}).value || '#333333',
        size: Math.max(8, Math.min(300, Number((document.getElementById('dp-collage-size') || {}).value) || 20)),
    };
    const words = s.collageWords = s.collageWords || [];
    words.push(word);
    saveSettingsDebounced();
    collageState.sel = words.length - 1;
    collageRenderControls();
    renderCollageCanvas();
}
let collageImportCandidates = [];
let collageImportSelected = new Set();
let collageImportMode = 'word';

/** 把文本拆成候选单元：按词（Intl.Segmenter，失败回退按空白）或逐字 */
function collageSplitText(text, mode) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return [];
    if (mode === 'char') {
        return Array.from(t).filter((c) => c.trim());
    }
    try {
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const seg = new Intl.Segmenter('zh', { granularity: 'word' });
            return Array.from(seg.segment(t)).map((s2) => s2.segment).filter((x) => x.trim());
        }
    } catch (e) { /* noop */ }
    return t.split(' ').filter((x) => x.trim());
}

/** 打开导入选择弹窗：读取主面板输入文字，拆成可多选的候选单元 */
function collageOpenImportPicker() {
    const quoteInput = document.getElementById('dp-quote-input');
    const quote = quoteInput ? quoteInput.value : '';
    const text = String(quote || '').trim();
    if (!text) { toast('warning', '请先在主面板输入或选中一段文字'); return; }
    collageImportMode = 'word';
    collageImportSelected = new Set();
    collageImportCandidates = collageSplitText(text, collageImportMode);
    if (!collageImportCandidates.length) { toast('warning', '未识别到可导入的文字'); return; }
    const pick = document.getElementById('dp-collage-pick');
    if (pick) {
        pick.style.display = 'block';
        try { pick.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* noop */ }
    }
    collageRenderImportPicker();
}

function collageRenderImportPicker() {
    const box = document.getElementById('dp-pick-list');
    if (!box) return;
    const mw = document.getElementById('dp-pick-mode-word');
    const mc = document.getElementById('dp-pick-mode-char');
    const mf = document.getElementById('dp-pick-mode-free');
    if (mw) mw.classList.toggle('on', collageImportMode === 'word');
    if (mc) mc.classList.toggle('on', collageImportMode === 'char');
    if (mf) mf.classList.toggle('on', collageImportMode === 'free');
    const srcBox = document.getElementById('dp-pick-source');
    if (srcBox) srcBox.style.display = collageImportMode === 'free' ? 'block' : 'none';
    const stuck = new Set((getSettings().collageWords || []).map((w) => w.text));
    box.innerHTML = collageImportCandidates.map((c, i) => {
        const on = collageImportSelected.has(i);
        const done = stuck.has(c) ? ' done' : '';
        return `<button type="button" class="dp-pick-chip${on ? ' on' : ''}${done}" data-i="${i}">${esc(c)}</button>`;
    }).join('');
    const cnt = document.getElementById('dp-pick-count');
    if (cnt) cnt.textContent = collageImportMode === 'free' ? collageImportCandidates.length : collageImportSelected.size;
}

/** 把勾选的字/词逐个添加为纸片（参数继承工具区当前值；多字词随机散落，保留原有词条） */
function collageImportPicked() {
    const s = getSettings();
    const words = s.collageWords = s.collageWords || [];
    const picked = Array.from(collageImportSelected).sort((a, b) => a - b).map((i) => collageImportCandidates[i]);
    if (!picked.length) { toast('warning', '请先勾选要导入的字/词'); return; }
    const size = collageImgSize();
    const W = size ? size.W : 1080;
    const H = size ? size.H : 1470;
    const shape = (document.getElementById('dp-cb-shape') || {}).value || 'round';
    const paper = (document.getElementById('dp-cb-paper') || {}).value || 'plain';
    const bg = (document.getElementById('dp-cb-bg') || {}).value || '#f5eedd';
    const fg = (document.getElementById('dp-cb-fg') || {}).value || '#333333';
    const rot = Math.max(-360, Math.min(360, Number((document.getElementById('dp-cb-rot') || {}).value) || 0));
    const fsize = Math.max(8, Math.min(300, Number((document.getElementById('dp-cb-size') || {}).value) || 20));
    const fw = Math.max(20, Math.min(1000, Number((document.getElementById('dp-cb-w') || {}).value) || 120));
    const fh = Math.max(20, Math.min(1000, Number((document.getElementById('dp-cb-h') || {}).value) || 80));
    picked.forEach((txt) => {
        const chars = Array.from(txt).length;
        const isShort = chars <= 2;
        const bw = fw;
        const bh = fh;
        const spot = collageFindSpot(W, H, bw, bh, words);
        words.push({
            id: `cw_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
            text: txt,
            x: spot.x,
            y: spot.y,
            w: bw,
            h: bh,
            rot,
            shape,
            paper,
            ah: 'center',
            av: 'middle',
            bg,
            fg,
            size: fsize,
        });
    });
    saveSettingsDebounced();
    collageState.sel = -1;
    collageRenderControls();
    renderCard();
    const modal = document.getElementById('dp-import-modal');
    if (modal) modal.style.display = 'none';
    toast('success', `已导入 ${picked.length} 个纸片，可在画布上拖动/旋转/裁剪`);
}

function collageDeleteSelected() {
    const i = collageState.sel;
    const s = getSettings();
    if (i < 0 || !s.collageWords || !s.collageWords[i]) return;
    s.collageWords.splice(i, 1);
    saveSettingsDebounced();
    collageState.sel = -1;
    collageRenderControls();
    renderCollageCanvas();
}

/** 纸张材质背景（内联到纸片样式，不依赖 CSS 类——预览/下载克隆/主文档画布全部生效） */
/** 上传材质图片缓存（用户上传的纸张素材——canvas 预览/下载 drawImage 同一张图，保证完全一致） */
/** 内置纸张材质（16 种，懒加载不卡顿） */
const COLLAGE_BUILTIN_PAPERS = [];
let collagePaperImgObj = null;
let collagePaperImgUrl = null;

/** 加载内置材质图（fetch→blob→objectURL→Image，避免跨域污染画布） */
async function collageLoadBuiltinPaper(id) {
    const hit = COLLAGE_BUILTIN_PAPERS.find((x) => x.id === id);
    if (!hit) return;
    collagePaperImgObj = null;
    collagePaperImgUrl = null;
    try {
        const im = new Image();
        await new Promise((res2, rej2) => {
            im.onload = () => res2();
            im.onerror = () => rej2(new Error('img fail'));
            im.src = hit.url;
        });
        collagePaperImgObj = im;
        collagePaperImgUrl = hit.url;
        renderCollageCanvas();
    } catch (e) {
        collagePaperImgObj = null;
        collagePaperImgUrl = null;
        try { if (window.toastr && toastr.warning) toastr.warning('材质图加载失败'); } catch (e2) { /* noop */ }
    }
}
const PAPER_IMG = {
    plain: '',
    none: '',
    torn: '',
    kraft: 'repeating-linear-gradient(0deg, rgba(120,90,50,.12) 0 1px, transparent 1px 4px), linear-gradient(160deg, rgba(190,150,90,.4), rgba(160,120,70,.18) 50%, rgba(130,95,55,.34))',
    craft: 'repeating-linear-gradient(90deg, rgba(120,80,40,.12) 0 2px, transparent 2px 7px), linear-gradient(160deg, rgba(165,110,55,.44), rgba(125,80,38,.22) 55%, rgba(100,62,28,.38))',
    xuan: 'radial-gradient(rgba(160,130,90,.32) .8px, transparent 1.2px)',
    news: 'repeating-linear-gradient(0deg, rgba(80,80,80,.18) 0 1px, transparent 1px 10px)',
    lined: 'repeating-linear-gradient(0deg, rgba(90,140,220,.4) 0 1px, transparent 1px 13px)',
    grid: 'repeating-linear-gradient(0deg, rgba(90,140,220,.34) 0 1px, transparent 1px 15px), repeating-linear-gradient(90deg, rgba(90,140,220,.34) 0 1px, transparent 1px 15px)'
};

/** 生成拼贴卡片内部 HTML（词条用百分比定位，输出与背景图 1:1） */
function buildCollageHtml(words, W, H) {
    const stack = collageFontStack();
    return (words || []).map((w) => {
        const x = (w.x / W) * 100;
        const y = (w.y / H) * 100;
        const ww = (w.w / W) * 100;
        const hh = (w.h / H) * 100;
        const rot = Number(w.rot) || 0;
        const ah = w.ah || 'center';
        const av = w.av || 'middle';
        const jc = ah === 'left' ? 'flex-start' : ah === 'right' ? 'flex-end' : 'center';
        const ai = av === 'top' ? 'flex-start' : av === 'bottom' ? 'flex-end' : 'center';
        return `<div class="dp-collage-word dp-paper-${w.paper || 'plain'}" style="left:${x.toFixed(3)}%;top:${y.toFixed(3)}%;width:${ww.toFixed(3)}%;height:${hh.toFixed(3)}%;transform:rotate(${rot}deg);background-color:${w.paper === 'custom' ? 'transparent' : esc(w.bg || '#f5eedd')};background-image:${w.paper === 'custom' ? (getSettings().collagePaperImg ? `url('${getSettings().collagePaperImg}')` : '') : (PAPER_IMG[w.paper || 'plain'] || '')};background-size:${w.paper === 'xuan' ? '6px 6px' : '100% 100%'};color:${esc(w.fg || '#333333')};border-radius:${collageShapeCss(w.shape)};font-size:${Math.max(8, Number(w.size) || 20)}px;font-family:${stack};"><span style="display:flex;align-items:${ai};justify-content:${jc};width:100%;height:100%;padding:6px;box-sizing:border-box;">${esc(w.text || '')}</span><i class="dp-collage-resize" title="拖拽裁剪大小"></i></div>`;
    }).join('');
}

// =====================================================================
// 初始化
// =====================================================================

function ensureLauncherTop() {
    try {
        // 把所有插件浮层统一挂到 <html> 顶层（避免被酒馆/其他扩展的 transform 容器或同层级浮层遮挡，
        // 保证手机端点击与面板显示不受 fork 的高 z-index 浮层影响）
        ['dp-launcher', 'dp-float-btn', 'dp-modal', 'dp-tpl-modal', 'dp-id-modal', 'dp-archive-modal', 'dp-sticker-modal', 'dp-ctx-menu', 'dp-import-modal'].forEach((id) => {
            const el = document.getElementById(id);
            if (el && el.parentElement !== document.documentElement) {
                document.documentElement.appendChild(el);
            }
        });
    } catch (e) { /* noop */ }
}
function positionLauncher() {
    try {
        const l = document.getElementById('dp-launcher');
        if (!l) return;
        ensureLauncherTop();
        const h = l.offsetHeight || 44;
        const w = l.offsetWidth || 96;
        const vw = window.innerWidth || document.documentElement.clientWidth || 800;
        const vh = window.innerHeight || document.documentElement.clientHeight || 800;
        let gap = 86;
        try {
            const nb = document.getElementById('nicole-toggle-btn');
            if (nb && nb.getBoundingClientRect) {
                const nr = nb.getBoundingClientRect();
                if (nr.height > 0 && nr.y > 0) {
                    gap = Math.max(gap, vh - nr.y + 14);
                }
            }
        } catch (e) { /* noop */ }
        l.style.position = 'fixed';
        l.style.left = Math.max(8, vw - w - 18) + 'px';
        l.style.top = Math.max(0, vh - h - gap) + 'px';
        l.style.right = 'auto';
        l.style.bottom = 'auto';
        l.style.zIndex = '2147483647';
        l.style.pointerEvents = 'auto';
        l.style.touchAction = 'manipulation';
    } catch (e) { /* noop */ }
}

// 全局错误捕获：手机端 / 任何环境报错都打印带前缀日志，便于定位「不显示」根因
window.addEventListener('error', (ev) => {
    try {
        console.error('[晋江段评] 全局错误:', ev.message, '@', (ev.filename || '').split('/').pop(), ':', ev.lineno);
    } catch { /* noop */ }
});

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

jQuery(async () => {
    // 防重复初始化：system 与 third-party 两份同时存在时只执行一次
    if (window.__dpInitialized) return;
    window.__dpInitialized = true;

    getSettings();
    injectShell();
    try { ensureLauncherTop(); } catch (e) { /* noop */ }
    try { positionLauncher(); } catch (e) { /* noop */ }
    // 加载成功可见标记：标题显示 [段评OK]，无需点任何东西即可确认插件已加载
    try {
        setTimeout(() => {
            if (document.title && !document.title.includes('[段评OK]')) {
                document.title = '[段评OK] ' + document.title;
            }
        }, 4000);
    } catch (e) { /* noop */ }
    // 全局捕获兜底：任何指针/触摸/点击事件落到 launcher 区域都尝试打开面板
    try {
        if (!window.__dpCapBound) {
            window.__dpCapBound = true;
            const cap = (ev) => {
                try {
                    const t = ev.target;
                    if (!t || !t.closest) return;
                    if (t.closest('#dp-launcher') || t.closest('#dp-float-btn')) {
                        ev.preventDefault && ev.preventDefault();
                        try { openDuanpingPanel(); } catch (e2) { console.warn('[晋江段评] cap open', e2); }
                    }
                } catch (e3) { /* noop */ }
            };
            ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((et) => {
                document.addEventListener(et, cap, true);
            });
        }
    } catch (e) { /* noop */ }
    try { ensureLauncherTop(); } catch (e) { /* noop */ }
    try { positionLauncher(); } catch (e) { /* noop */ }
    // 加载成功可见标记：标题显示 [段评OK]，无需点任何东西即可确认插件已加载
    try {
        setTimeout(() => {
            if (document.title && !document.title.includes('[段评OK]')) {
                document.title = '[段评OK] ' + document.title;
            }
        }, 4000);
    } catch (e) { /* noop */ }
    // 全局捕获兜底：任何指针/触摸/点击事件落到 launcher 区域都尝试打开面板
    try {
        if (!window.__dpCapBound) {
            window.__dpCapBound = true;
            const cap = (ev) => {
                try {
                    const t = ev.target;
                    if (!t || !t.closest) return;
                    if (t.closest('#dp-launcher') || t.closest('#dp-float-btn')) {
                        ev.preventDefault && ev.preventDefault();
                        try { openDuanpingPanel(); } catch (e2) { console.warn('[晋江段评] cap open', e2); }
                    }
                } catch (e3) { /* noop */ }
            };
            ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((et) => {
                document.addEventListener(et, cap, true);
            });
        }
    } catch (e) { /* noop */ }
    try { ensureLauncherTop(); } catch (e) { /* noop */ }
    try { positionLauncher(); } catch (e) { /* noop */ }
    // 加载成功可见标记：标题显示 [段评OK]，无需点任何东西即可确认插件已加载
    try {
        setTimeout(() => {
            if (document.title && !document.title.includes('[段评OK]')) {
                document.title = '[段评OK] ' + document.title;
            }
        }, 4000);
    } catch (e) { /* noop */ }
    // 全局捕获兜底：任何指针/触摸/点击事件落到 launcher 区域都尝试打开面板
    try {
        if (!window.__dpCapBound) {
            window.__dpCapBound = true;
            const cap = (ev) => {
                try {
                    const t = ev.target;
                    if (!t || !t.closest) return;
                    if (t.closest('#dp-launcher') || t.closest('#dp-float-btn')) {
                        ev.preventDefault && ev.preventDefault();
                        try { openDuanpingPanel(); } catch (e2) { console.warn('[晋江段评] cap open', e2); }
                    }
                } catch (e3) { /* noop */ }
            };
            ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((et) => {
                document.addEventListener(et, cap, true);
            });
        }
    } catch (e) { /* noop */ }
    try { ensureLauncherTop(); } catch (e) { /* noop */ }
    try { positionLauncher(); } catch (e) { /* noop */ }
    // 加载成功可见标记：标题显示 [段评OK]，无需点任何东西即可确认插件已加载
    try {
        setTimeout(() => {
            if (document.title && !document.title.includes('[段评OK]')) {
                document.title = '[段评OK] ' + document.title;
            }
        }, 4000);
    } catch (e) { /* noop */ }
    // 全局捕获兜底：任何指针/触摸/点击事件落到 launcher 区域都尝试打开面板
    try {
        if (!window.__dpCapBound) {
            window.__dpCapBound = true;
            const cap = (ev) => {
                try {
                    const t = ev.target;
                    if (!t || !t.closest) return;
                    if (t.closest('#dp-launcher') || t.closest('#dp-float-btn')) {
                        ev.preventDefault && ev.preventDefault();
                        try { openDuanpingPanel(); } catch (e2) { console.warn('[晋江段评] cap open', e2); }
                    }
                } catch (e3) { /* noop */ }
            };
            ['pointerdown', 'touchstart', 'mousedown', 'click'].forEach((et) => {
                document.addEventListener(et, cap, true);
            });
        }
    } catch (e) { /* noop */ }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'duanping',
        aliases: ['dp'],
        callback: slashDuanping,
        helpString: '打开晋江段评面板（可传入文本参数 /duanping 你好呀）。',
        returnsHelpString: true,
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'duanping-template',
        aliases: ['dpt'],
        callback: slashTemplateManager,
        helpString: '打开晋江段评模板管理。',
        returnsHelpString: true,
    }));

    console.log('[晋江段评] 已加载。长按/拖选聊天文本后点击「✎ 段评」开始。');
});
