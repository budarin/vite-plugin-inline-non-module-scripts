import type { Plugin } from 'vite';

import path from 'path';
import { readFileSync } from 'fs';
import { load as loadHtml } from 'cheerio';

export interface VitePluginInlineNonModuleScriptsOptions {
    htmlPath?: string; // не используется в новой логике, сохранено для совместимости
    minify?:
        | boolean
        | ((code: string, config: unknown) => Promise<string> | string);
}

/**
 * Vite плагин для автоматической обработки не-модульных JavaScript скриптов
 *
 * Функциональность:
 * - Автоматически находит все локальные скрипты в HTML (не модули, не внешние)
 * - Минифицирует содержимое скриптов через встроенную минификацию Vite
 * - Заменяет ссылки на скрипты в HTML на инлайн-скрипты с минифицированным кодом
 * - Не создает файлы скриптов в dist/assets
 *
 * @param options - Опции плагина
 * @returns Vite плагин
 */
// Парсинг делаем через cheerio; regex не используется
// Оставлено как заметка: мы работаем только с <script src> без type="module"

const getSrcPath = (file: string) => path.resolve(process.cwd(), file);

export function inlineNonModuleScriptsPlugin(
    options: VitePluginInlineNonModuleScriptsOptions = {}
): Plugin {
    const { minify: minifyOption } = options;
    let resolvedConfig: unknown | undefined;

    function isLocalScript(src: string): boolean {
        return (
            !src.startsWith('http://') &&
            !src.startsWith('https://') &&
            !src.startsWith('//')
        );
    }

    function isValidScriptPath(src: string): boolean {
        return src.endsWith('.js') || src.endsWith('.mjs');
    }
    function hasDisallowedAttrs(openingTag: string): boolean {
        return /(\basync\b|\bdefer\b|\bintegrity\b|\bcrossorigin\b)/i.test(
            openingTag
        );
    }

    return {
        name: 'vite-plugin-inline-non-module-scripts',
        apply: 'build',
        enforce: 'pre',

        configResolved(config) {
            resolvedConfig = config;
        },

        async transformIndexHtml(html: string) {
            const debug = process.env.NON_MODULE_INLINER_DEBUG === '1';
            const $ = loadHtml(html);

            const nodes = $('script[src]');
            for (let i = 0; i < nodes.length; i++) {
                const el = nodes[i] as any;
                const $el = $(el);
                const src: string = $el.attr('src') || '';
                const type: string = ($el.attr('type') || '').toLowerCase();
                if (!src) continue;
                if (type === 'module') continue;

                const openingTag =
                    $.html(el).match(/^<script[^>]*>/i)?.[0] ?? '';
                if (!isLocalScript(src)) {
                    if (debug) console.log('[inline-nm] skip external', src);
                    continue;
                }
                if (!isValidScriptPath(src)) {
                    if (debug) console.log('[inline-nm] skip ext', src);
                    continue;
                }
                if (hasDisallowedAttrs(openingTag)) {
                    if (debug) console.log('[inline-nm] skip attrs', src);
                    continue;
                }

                const filePath = getSrcPath(
                    src.startsWith('/') ? src.slice(1) : src
                );
                let code = '';
                try {
                    code = readFileSync(filePath, 'utf-8');
                } catch (e) {
                    if (debug) console.warn('[inline-nm] read fail', src, e);
                    continue;
                }

                if (typeof minifyOption === 'function') {
                    try {
                        const out = minifyOption(code, resolvedConfig);
                        code = (out as any)?.then
                            ? await (out as Promise<string>)
                            : (out as string);
                    } catch (e) {
                        if (debug)
                            console.warn('[inline-nm] minify fail', src, e);
                    }
                }

                // mutate DOM: remove src, keep other attrs
                $el.removeAttr('src');
                if (type === 'module') $el.removeAttr('type');
                $el.text(code);
                if (debug) console.log('[inline-nm] inlined', src);
            }

            return $.html();
        },
    };
}

export default inlineNonModuleScriptsPlugin;
