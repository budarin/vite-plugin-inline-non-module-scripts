import type { Plugin } from 'vite';

import path from 'path';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';

export interface VitePluginInlineNonModuleScriptsOptions {
    htmlPath?: string;
    minify?: boolean;
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
// Кэшируем регулярные выражения для производительности
const SCRIPT_WITH_SRC_REGEX =
    /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi;

const INLINE_SCRIPT_REGEX =
    /<script(?![^>]*type\s*=\s*["']module["'])(?![^>]*\ssrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

// Кэшируем часто используемые пути
const getDistPath = (file: string) => path.resolve(process.cwd(), 'dist', file);
const getSrcPath = (file: string) => path.resolve(process.cwd(), file);

export function vitePluginInlineNonModuleScripts(
    options: VitePluginInlineNonModuleScriptsOptions = {}
): Plugin {
    const { htmlPath = 'index.html', minify: minifyOption } = options;
    const virtualModulePrefix = '\0non-module-script:';

    let viteMinify: boolean | 'esbuild' | 'terser' = true;
    let shouldMinify: boolean = true;

    const scriptData: Array<{
        original: string;
        src?: string; // Для скриптов с src
        fullPath?: string; // Для скриптов с src
        content?: string; // Для инлайн-скриптов
        chunkId?: string;
        minifiedContent?: string;
        fileName?: string;
        isInline?: boolean; // Флаг для инлайн-скриптов
    }> = [];

    function isLocalScript(src: string): boolean {
        return (
            !src.startsWith('http://') &&
            !src.startsWith('https://') &&
            !src.startsWith('//')
        );
    }

    function findNonModuleScripts(html: string): Array<{
        original: string;
        src?: string;
        fullPath?: string;
        content?: string;
        isInline?: boolean;
    }> {
        const scripts = [];
        let match;

        // Ищем скрипты с src атрибутом
        SCRIPT_WITH_SRC_REGEX.lastIndex = 0;
        while ((match = SCRIPT_WITH_SRC_REGEX.exec(html)) !== null) {
            const fullMatch = match[0];
            const src = match[1];

            if (isLocalScript(src)) {
                const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
                const fullPath = getSrcPath(cleanSrc);

                scripts.push({
                    original: fullMatch,
                    src,
                    fullPath,
                    isInline: false,
                });
            }
        }

        // Ищем инлайн-скрипты
        INLINE_SCRIPT_REGEX.lastIndex = 0;
        while ((match = INLINE_SCRIPT_REGEX.exec(html)) !== null) {
            const fullMatch = match[0];
            const content = match[1].trim();

            // Пропускаем пустые скрипты
            if (content) {
                scripts.push({
                    original: fullMatch,
                    content,
                    isInline: true,
                });
            }
        }

        return scripts;
    }

    return {
        name: 'vite-plugin-inline-non-module-scripts',

        configResolved(config) {
            // Читаем настройку minify из конфига Vite
            viteMinify = config.build.minify;

            // Вычисляем нужно ли минифицировать один раз
            shouldMinify =
                minifyOption !== undefined
                    ? minifyOption
                    : viteMinify !== false;
        },

        resolveId(id) {
            if (id.startsWith(virtualModulePrefix)) {
                return id;
            }
            return null;
        },

        load(id) {
            if (id.startsWith(virtualModulePrefix)) {
                // Если это инлайн-скрипт (начинается с inline-script-)
                if (id.includes('inline-script-')) {
                    // Находим соответствующий скрипт по virtualId
                    const script = scriptData.find(
                        (s) => (s as any).virtualId === id
                    );
                    return script?.content || '';
                } else {
                    // Обычный скрипт с файлом
                    const scriptPath = id.slice(virtualModulePrefix.length);
                    return readFileSync(scriptPath, 'utf-8');
                }
            }
            return null;
        },

        buildStart() {
            // Очищаем данные о скриптах
            scriptData.length = 0;

            // Читаем HTML и находим скрипты
            const fullHtmlPath = getSrcPath(htmlPath);
            try {
                const htmlContent = readFileSync(fullHtmlPath, 'utf-8');
                const foundScripts = findNonModuleScripts(htmlContent);
                scriptData.push(...foundScripts);

                // Обрабатываем скрипты в зависимости от типа
                for (const script of foundScripts) {
                    if (script.isInline) {
                        // Инлайн-скрипты - обрабатываем содержимое напрямую
                        if (shouldMinify) {
                            // Используем chunk для минификации инлайн-скриптов через виртуальный модуль
                            const virtualId =
                                virtualModulePrefix +
                                'inline-script-' +
                                Date.now() +
                                '-' +
                                Math.random().toString(36).substr(2, 9);
                            const chunkId = this.emitFile({
                                type: 'chunk',
                                id: virtualId,
                                name: 'inline-script',
                            });
                            (script as any).chunkId = chunkId;
                            (script as any).virtualId = virtualId;
                        } else {
                            // Без минификации - используем содержимое как есть
                            (script as any).minifiedContent = script.content;
                        }
                    } else {
                        // Скрипты с src - обрабатываем как раньше
                        if (shouldMinify) {
                            const virtualId =
                                virtualModulePrefix + script.fullPath;
                            const chunkId = this.emitFile({
                                type: 'chunk',
                                id: virtualId,
                                name: path
                                    .basename(script.fullPath!)
                                    .replace('.js', ''),
                            });
                            (script as any).chunkId = chunkId;
                        } else {
                            // Если минификация отключена, читаем оригинальное содержимое
                            try {
                                const scriptContent = readFileSync(
                                    script.fullPath!,
                                    'utf-8'
                                );
                                (script as any).minifiedContent = scriptContent;
                            } catch (error) {
                                console.error(
                                    `[vite-plugin-inline-non-module-scripts] Error reading script file ${script.fullPath}:`,
                                    error
                                );
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(
                    `[non-module-script-processor] Error reading HTML file:`,
                    error
                );
            }
        },

        // Убираем дублирование - не нужно искать скрипты в transformIndexHtml
        // так как мы уже нашли их в buildStart

        async generateBundle() {
            // Получаем имена файлов для последующего чтения (только если минификация включена)
            if (shouldMinify) {
                for (const script of scriptData) {
                    if (script.chunkId) {
                        try {
                            const fileName = this.getFileName(script.chunkId);
                            script.fileName = fileName;
                        } catch (error) {
                            console.error(
                                `[vite-plugin-inline-non-module-scripts] Error getting file name:`,
                                error
                            );
                        }
                    }

                    // Инлайн-скрипты обрабатываются через chunks в основном цикле выше
                }
            }
        },

        async writeBundle() {
            if (shouldMinify) {
                // Читаем минифицированное содержимое из созданных файлов
                for (const script of scriptData) {
                    if (script.fileName) {
                        try {
                            const filePath = getDistPath(script.fileName);

                            // Читаем минифицированное содержимое
                            const minifiedContent = readFileSync(
                                filePath,
                                'utf-8'
                            );

                            // Удаляем временный файл
                            unlinkSync(filePath);

                            // Сохраняем минифицированное содержимое
                            script.minifiedContent = minifiedContent;
                        } catch (error) {
                            console.error(
                                `[vite-plugin-inline-non-module-scripts] Error processing minified file:`,
                                error
                            );
                        }
                    }

                    // Assets для инлайн-скриптов обрабатываются в основном цикле выше
                }
            }
            // Если минификация отключена, содержимое уже прочитано в buildStart

            // Обновляем HTML с инлайн-скриптами
            const htmlPath = getDistPath('index.html');
            let htmlContent = readFileSync(htmlPath, 'utf-8');

            // Оптимизируем замену - делаем все замены за один проход
            for (const script of scriptData) {
                if (script.minifiedContent) {
                    if (script.isInline) {
                        // Для инлайн-скриптов извлекаем атрибуты и заменяем содержимое
                        const attributes = script.original
                            .replace(/<script\s*/, '')
                            .replace(/>[\s\S]*<\/script>$/, '');

                        // Добавляем пробел перед атрибутами если они есть
                        const attributesStr = attributes.trim()
                            ? ` ${attributes.trim()}`
                            : '';
                        const replacement = `<script${attributesStr}>${script.minifiedContent}</script>`;
                        htmlContent = htmlContent.replace(
                            script.original,
                            replacement
                        );
                    } else {
                        // Для скриптов с src - извлекаем атрибуты кроме src
                        const attributes = script.original
                            .replace(/src\s*=\s*["'][^"']*["']/gi, '')
                            .replace(/<script\s*/, '')
                            .replace(/\s*><\/script>$/, '');

                        const replacement = `<script${attributes}>${script.minifiedContent}</script>`;
                        htmlContent = htmlContent.replace(
                            script.original,
                            replacement
                        );
                    }
                }
            }

            writeFileSync(htmlPath, htmlContent);
        },
    };
}

export default vitePluginInlineNonModuleScripts;
