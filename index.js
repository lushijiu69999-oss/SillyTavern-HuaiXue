// 1. 修正导入路径：从 scripts/extensions/third-party/[plugin] 向上返回四层到 public 根目录
import { eventSource, event_types, extension_prompt_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

const EXTENSION_NAME = 'ttrpg-rng-pool-d100';

const localPoolCache = new Map();
let currentChatId = null;
const CACHE_LIMIT = 20;

function setCacheWithLimit(key, value) {
    if (localPoolCache.size >= CACHE_LIMIT) {
        const oldestKey = localPoolCache.keys().next().value;
        localPoolCache.delete(oldestKey);
        console.log(`[${EXTENSION_NAME}] 内存缓存达到上限(${CACHE_LIMIT})，已自动淘汰最老的数据:`, oldestKey);
    }
    localPoolCache.set(key, value);
}

function getMessageHash(str) {
    let hash = 0;
    if (!str || str.length === 0) return '0';
    const cleanStr = String(str).trim().replace(/\r\n/g, '\n');
    for (let i = 0; i < cleanStr.length; i++) {
        let char = cleanStr.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

function generateStrictRandomD100() {
    try {
        if (typeof window !== 'undefined' && window.crypto && window.crypto.getRandomValues) {
            const array = new Uint32Array(1);
            const maxValid = 4294967295 - (4294967295 % 100); 
            do {
                window.crypto.getRandomValues(array);
            } while (array[0] >= maxValid);
            return (array[0] % 100) + 1;
        }
        throw new Error('CSPRNG is not available');
    } catch (e) {
        return Math.floor(Math.random() * 100) + 1;
    }
}

function generateDicePool(size = 16) {
    const rolls = [];
    for (let i = 0; i < size; i++) {
        rolls.push(generateStrictRandomD100());
    }
    return rolls;
}

function formatPromptText(rolls) {
    const rollsText = rolls.map((val, idx) => `骰子${idx + 1}:${val}`).join(', ');
    return `\n<system_rng_mechanism>
[系统强制执行：这是一组专供你**本次最新回复**使用的全新独立暗骰池 { ${rollsText} }。
⚠️ 覆盖指令：
1. 状态重置：你必须完全无视历史对话中曾经使用过的骰子序号。
2. 从头取值：在接下来的回复中，只要触发判定，必须强制**重新从“骰子1”开始**依次提取数值（即：本次回复的第一个判定用骰子1，第二个用骰子2）。
3. 严禁顺延：绝对不能继承或顺延上一轮的序号（例如禁止从骰子4开始取值），严禁自行编造数值。
4. 显式声明：使用时需标明（例如：“（根据本次骰子1的数值 45...）”）。]
</system_rng_mechanism>`;
}

// 【核心修改】将原本在 GENERATION_STARTED 中的逻辑提取为独立的同步函数
function syncDicePool() {
    try {
        const context = getContext();
        if (!context || !context.chat || context.chat.length === 0) return;

        let lastUserMsgIndex = -1;
        for (let i = context.chat.length - 1; i >= 0; i--) {
            const msg = context.chat[i];
            if (msg && (msg.is_user === true || msg.is_user === 'true')) {
                lastUserMsgIndex = i;
                break;
            }
        }

        if (lastUserMsgIndex === -1) {
            lastUserMsgIndex = context.chat.length - 1;
        }

        const userMsg = context.chat[lastUserMsgIndex] || {};

        const chatId = String(context.chatId || 'default');
        if (!currentChatId) {
            currentChatId = chatId;
        }
        
        const msgId = String(userMsg.send_date || lastUserMsgIndex);
        const textHash = getMessageHash(userMsg.mes || '');
        const cacheKey = `${chatId}_${msgId}_${textHash}`;

        if (!context.chatMetadata) {
            context.chatMetadata = {};
        }
        if (!context.chatMetadata[EXTENSION_NAME] || Array.isArray(context.chatMetadata[EXTENSION_NAME])) {
            context.chatMetadata[EXTENSION_NAME] = {};
        }

        let dicePool;
        const savedPools = context.chatMetadata[EXTENSION_NAME];

        if (localPoolCache.has(cacheKey)) {
            dicePool = localPoolCache.get(cacheKey);
            savedPools[cacheKey] = dicePool;
            console.log(`[${EXTENSION_NAME}] 【成功复用】从内存缓存获取 (Key: ${cacheKey}):`, dicePool);
        } else if (savedPools[cacheKey]) {
            dicePool = savedPools[cacheKey];
            setCacheWithLimit(cacheKey, dicePool);
            console.log(`[${EXTENSION_NAME}] 【元数据恢复】从磁盘数据中恢复 (Key: ${cacheKey}):`, dicePool);
        } else {
            dicePool = generateDicePool(16);
            savedPools[cacheKey] = dicePool;
            setCacheWithLimit(cacheKey, dicePool);

            const metadataKeys = Object.keys(savedPools);
            if (metadataKeys.length > CACHE_LIMIT * 2) {
                delete savedPools[metadataKeys[0]];
            }

            context.saveMetadata().catch(err => {
                console.error(`[${EXTENSION_NAME}] 异步保存聊天元数据失败:`, err);
            });
            console.log(`[${EXTENSION_NAME}] 【全新生成】已创建骰子池 (Key: ${cacheKey}):`, dicePool);
        }

        const injectionText = formatPromptText(dicePool);
        
// 修正后的注入方式
context.setExtensionPrompt(
    EXTENSION_NAME,
    injectionText,
    extension_prompt_types.IN_CHAT, // [修改] 注入到对话流中，伪装成 System 消息
    1                               // [修改] 深度 1 或 0（通常 1 代表在最新一条用户消息之前，0 代表最末尾）
);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] 同步骰子池失败:`, error);
    }
}

// 初始化插件
jQuery(() => {
    try {
        // 【核心修改】废弃 GENERATION_STARTED，改用前置交互事件触发
        // 在用户交互改变了对话内容时，立刻更新骰子池
        eventSource.on(event_types.MESSAGE_SENT, syncDicePool);
        eventSource.on(event_types.MESSAGE_EDITED, syncDicePool);
        eventSource.on(event_types.MESSAGE_DELETED, syncDicePool);

        eventSource.on(event_types.CHAT_CHANGED, () => {
            const context = getContext();
            const newChatId = String(context ? (context.chatId || 'default') : 'default');
            
            if (newChatId && newChatId !== currentChatId) {
                localPoolCache.clear();
                currentChatId = newChatId;
                console.log(`[${EXTENSION_NAME}] 检测到更换了聊天角色/存档，已清空内存缓存。`);
            }
            // 切换聊天室后立刻同步一次当前状态
            syncDicePool();
        });

        // 插件加载完成时，预先同步一次（延迟 1 秒等待 ST 读取完历史对话数据）
        setTimeout(syncDicePool, 1000);

        console.log(`[${EXTENSION_NAME}] 扩展加载成功。`);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] 扩展初始化失败:`, error);
    }
});
