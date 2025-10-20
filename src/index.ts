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
export function vitePluginInlineNonModuleScripts(
    options: VitePluginInlineNonModuleScriptsOptions = {}
): Plugin {
    const { htmlPath = 'index.html', minify: minifyOption } = options;
    const virtualModulePrefix = '\0non-module-script:';

    let viteMinify: boolean | 'esbuild' | 'terser' = true;

    // Кэшируем регулярное выражение для производительности
    const SCRIPT_REGEX =
        /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi;

    const scriptData: Array<{
        original: string;
        src: string;
        fullPath: string;
        chunkId?: string;
        minifiedContent?: string;
        fileName?: string;
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
        src: string;
        fullPath: string;
    }> {
        const scripts = [];
        let match;

        // Сбрасываем lastIndex для повторного использования regex
        SCRIPT_REGEX.lastIndex = 0;

        while ((match = SCRIPT_REGEX.exec(html)) !== null) {
            const fullMatch = match[0];
            const src = match[1];

            if (isLocalScript(src)) {
                const cleanSrc = src.startsWith('/') ? src.slice(1) : src;
                const fullPath = path.resolve(process.cwd(), cleanSrc);

                scripts.push({
                    original: fullMatch,
                    src,
                    fullPath,
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
        },

        resolveId(id) {
            if (id.startsWith(virtualModulePrefix)) {
                return id;
            }
            return null;
        },

        load(id) {
            if (id.startsWith(virtualModulePrefix)) {
                const scriptPath = id.slice(virtualModulePrefix.length);
                return readFileSync(scriptPath, 'utf-8');
            }
            return null;
        },

        buildStart() {
            // Очищаем данные о скриптах
            scriptData.length = 0;

            // Читаем HTML и находим скрипты
            const fullHtmlPath = path.resolve(process.cwd(), htmlPath);
            try {
                const htmlContent = readFileSync(fullHtmlPath, 'utf-8');
                const foundScripts = findNonModuleScripts(htmlContent);
                scriptData.push(...foundScripts);

                // Определяем нужно ли минифицировать
                // Приоритет: опция плагина > конфиг Vite > false
                const shouldMinify =
                    minifyOption !== undefined
                        ? minifyOption
                        : viteMinify !== false; // Используем настройку из конфига Vite

                // Эмитим chunks для минификации (если включена)
                if (shouldMinify) {
                    for (const script of foundScripts) {
                        const virtualId = virtualModulePrefix + script.fullPath;
                        const chunkId = this.emitFile({
                            type: 'chunk',
                            id: virtualId,
                            name: path
                                .basename(script.fullPath)
                                .replace('.js', ''),
                        });
                        (script as any).chunkId = chunkId;
                    }
                } else {
                    // Если минификация отключена, читаем оригинальное содержимое
                    for (const script of foundScripts) {
                        try {
                            const scriptContent = readFileSync(
                                script.fullPath,
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
            const shouldMinify =
                minifyOption !== undefined
                    ? minifyOption
                    : viteMinify !== false;

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
                }
            }
        },

        async writeBundle() {
            const shouldMinify =
                minifyOption !== undefined
                    ? minifyOption
                    : viteMinify !== false;

            if (shouldMinify) {
                // Читаем минифицированное содержимое из созданных файлов
                for (const script of scriptData) {
                    if (script.fileName) {
                        try {
                            const filePath = path.resolve(
                                process.cwd(),
                                'dist',
                                script.fileName
                            );

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
                }
            }
            // Если минификация отключена, содержимое уже прочитано в buildStart

            // Обновляем HTML с инлайн-скриптами
            const htmlPath = path.resolve(process.cwd(), 'dist', 'index.html');
            let htmlContent = readFileSync(htmlPath, 'utf-8');

            // Оптимизируем замену - делаем все замены за один проход
            for (const script of scriptData) {
                if (script.minifiedContent) {
                    // Извлекаем атрибуты кроме src
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

            writeFileSync(htmlPath, htmlContent);
        },
    };
}

export default vitePluginInlineNonModuleScripts;
