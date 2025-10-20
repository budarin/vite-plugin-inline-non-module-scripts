import type { Plugin } from 'vite';

import path from 'path';
import { readFileSync } from 'fs';

export interface NonModuleScriptProcessorOptions {
    htmlPath?: string;
}

/**
 * Vite плагин для автоматической обработки не-модульных JavaScript скриптов
 *
 * Функциональность:
 * - Автоматически находит все локальные скрипты в HTML (не модули, не внешние)
 * - Заменяет ссылки на скрипты в HTML на инлайн-скрипты
 * - Не создает файлы скриптов в dist/assets
 *
 * @param options - Опции плагина
 * @returns Vite плагин
 */
export function nonModuleScriptProcessor(
    _options: NonModuleScriptProcessorOptions = {}
): Plugin {
    function isLocalScript(src: string): boolean {
        return (
            !src.startsWith('http://') &&
            !src.startsWith('https://') &&
            !src.startsWith('//')
        );
    }

    return {
        name: 'non-module-script-processor',

        async transformIndexHtml(html) {
            const scriptRegex =
                /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi;
            let match;
            const scriptsToInline = [];

            // Находим все не-модульные скрипты
            while ((match = scriptRegex.exec(html)) !== null) {
                const fullMatch = match[0];
                const src = match[1];

                if (isLocalScript(src)) {
                    try {
                        // Убираем ведущий слэш для корректного path.resolve
                        const cleanSrc = src.startsWith('/')
                            ? src.slice(1)
                            : src;
                        const fullPath = path.resolve(process.cwd(), cleanSrc);

                        // Читаем содержимое скрипта
                        const scriptContent = readFileSync(fullPath, 'utf-8');

                        // Извлекаем атрибуты кроме src
                        const attributes = fullMatch
                            .replace(/src\s*=\s*["'][^"']*["']/gi, '')
                            .replace(/<script\s*/, '')
                            .replace(/\s*><\/script>$/, '');

                        console.log(`[DEBUG] fullMatch: ${fullMatch}`);
                        console.log(`[DEBUG] attributes: "${attributes}"`);
                        console.log(
                            `[DEBUG] scriptContent length: ${scriptContent.length}`
                        );

                        scriptsToInline.push({
                            original: fullMatch,
                            replacement: `<script${attributes}>${scriptContent}</script>`,
                        });
                    } catch (error) {
                        console.error(
                            `[non-module-script-processor] Error processing script ${src}:`,
                            error
                        );
                    }
                }
            }

            // Заменяем все найденные скрипты на инлайн-скрипты
            let result = html;
            for (const { original, replacement } of scriptsToInline) {
                result = result.replace(original, replacement);
            }

            return result;
        },
    };
}
