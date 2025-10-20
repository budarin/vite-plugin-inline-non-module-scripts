# Архитектура плагина non-module-script-processor

## Задача плагина

Плагин обрабатывает non-module JavaScript скрипты, которые не обрабатываются Vite/Rolldown автоматически. Для каждого такого скрипта:

1. **Читает содержимое** скрипта из файла
2. **Опционально минифицирует** через встроенную минификацию Vite (если `minify: true`)
3. **Заменяет ссылки на инлайн-скрипты** с содержимым (минифицированным или оригинальным)
4. **НЕ создает файлы** в dist/assets (временные файлы удаляются)
5. **НЕ добавляет записи** в манифест

## Ключевое решение: Два режима работы

### Режим 1: Без минификации (по умолчанию)

- Читает оригинальное содержимое файлов
- Вставляет код как есть в HTML
- Быстрая работа, нет дополнительной обработки

### Режим 2: С минификацией (опция `minify: true`)

- Использует **Chunks** для получения минифицированного содержимого
- Удаляет временные файлы и вставляет код инлайн в HTML
- Автоматическая минификация через Vite/Rolldown

**Преимущества:**

- Гибкость - можно выбрать с минификацией или без
- Будущеустойчивость (работает с любыми минификаторами)
- Чистый результат (только инлайн-скрипты)

## Архитектура плагина

### 1. Виртуальные модули

Создаем виртуальные модули для каждого non-module скрипта:

```typescript
const virtualModulePrefix = '\0non-module-script:';

resolveId(id) {
    if (id.startsWith(virtualModulePrefix)) {
        return id; // Говорим Rolldown, что это валидный модуль
    }
    return null;
}

load(id) {
    if (id.startsWith(virtualModulePrefix)) {
        const scriptPath = id.slice(virtualModulePrefix.length);
        return readFileSync(scriptPath, 'utf-8');
    }
    return null;
}
```

### 2. Поиск скриптов в buildStart

В хуке `buildStart` находим все non-module скрипты и обрабатываем их в зависимости от режима:

```typescript
buildStart() {
    // Читаем HTML и находим скрипты
    const htmlContent = readFileSync(htmlPath, 'utf-8');
    const foundScripts = findNonModuleScripts(htmlContent);

    if (minify) {
        // Режим с минификацией: эмитим chunks
    for (const script of foundScripts) {
        const virtualId = virtualModulePrefix + script.fullPath;
        const chunkId = this.emitFile({
            type: 'chunk',
                id: virtualId,
                name: path.basename(script.fullPath).replace('.js', ''),
            });
        }
    } else {
        // Режим без минификации: читаем оригинальное содержимое
        for (const script of foundScripts) {
            const scriptContent = readFileSync(script.fullPath, 'utf-8');
            script.minifiedContent = scriptContent;
        }
    }
}
```

### 3. Vite/Rolldown обрабатывает chunks

После `emitFile` Vite/Rolldown:

1. Резолвит виртуальные модули через `resolveId`
2. Загружает код через `load`
3. Применяет минификацию из `build.minify`
4. Генерирует файлы с хэшами в `assets/`

### 4. Получение минифицированного содержимого

В `generateBundle` получаем имена файлов:

```typescript
generateBundle() {
    for (const script of scriptData) {
        if (script.chunkId) {
            const fileName = this.getFileName(script.chunkId);
            script.fileName = fileName;
        }
    }
}
```

### 5. Инлайн-вставка и очистка

В `writeBundle` читаем минифицированное содержимое, удаляем файлы и заменяем на инлайн-скрипты:

```typescript
writeBundle() {
    // Читаем минифицированное содержимое
    for (const script of scriptData) {
        const filePath = path.resolve(process.cwd(), 'dist', script.fileName);
        const minifiedContent = readFileSync(filePath, 'utf-8');

        // Удаляем временный файл
        unlinkSync(filePath);

        script.minifiedContent = minifiedContent;
    }

    // Заменяем теги на инлайн-скрипты
    for (const script of scriptData) {
        const attributes = extractAttributes(script.original);
        const replacement = `<script${attributes}>${script.minifiedContent}</script>`;
        htmlContent = htmlContent.replace(script.original, replacement);
    }
}
```

## Порядок выполнения хуков

### Режим без минификации (minify: false)

```
1. buildStart
   → Читаем HTML
   → Находим non-module скрипты
   → Читаем оригинальное содержимое файлов

2. writeBundle
   → Заменяем на инлайн-скрипты в HTML
```

### Режим с минификацией (minify: true)

```
1. buildStart
   → Читаем HTML
   → Находим non-module скрипты
   → Эмитим chunks через emitFile()

2. resolveId
   → Rolldown резолвит виртуальные модули

3. load
   → Rolldown загружает код скриптов

4. [Внутренняя обработка Rolldown]
   → Применяет минификацию из build.minify
   → Генерирует chunks с хэшами
   → Помещает в assets/

5. generateBundle
   → Получаем имена файлов через getFileName()

6. writeBundle
   → Читаем минифицированное содержимое
   → Удаляем временные файлы
   → Заменяем на инлайн-скрипты в HTML
```

## Оптимизации производительности

### 1. Кэширование регулярного выражения

```typescript
const SCRIPT_REGEX =
    /<script(?![^>]*type\s*=\s*["']module["'])[^>]*\ssrc\s*=\s*["']([^"']+)["'][^>]*><\/script>/gi;
```

### 2. Убрано дублирование поиска

- Поиск скриптов происходит только в `buildStart`
- Убран `transformIndexHtml` хук

### 3. Оптимизированная проверка локальных скриптов

```typescript
function isLocalScript(src: string): boolean {
    return (
        !src.startsWith('http://') &&
        !src.startsWith('https://') &&
        !src.startsWith('//')
    );
}
```

### 4. Правильное использование regex

```typescript
SCRIPT_REGEX.lastIndex = 0; // Сброс для повторного использования
```

## Будущеустойчивость

Плагин НЕ импортирует конкретные минификаторы. Вместо этого делегирует минификацию Vite/Rolldown, который применит настроенный минификатор автоматически.

**Совместимость:**

- ✅ Vite 2-6 с esbuild/terser
- ✅ Vite 7 с Rolldown и oxc
- ✅ Будущие версии с новыми минификаторами

## Результат

### Режим без минификации (по умолчанию)

- **Быстрая работа** - нет дополнительной обработки
- **Оригинальный код** - содержимое файлов как есть
- **Чистый HTML** с инлайн-скриптами
- **Нет лишних файлов** в dist/assets

### Режим с минификацией

- **Автоматическая минификация** любым настроенным минификатором
- **Оптимизированный код** - минифицированное содержимое
- **Чистый HTML** с инлайн-скриптами
- **Нет лишних файлов** в dist/assets
- **Нет записей в манифесте**

### Общие преимущества

- **Высокая производительность** благодаря оптимизациям
- **Гибкость** - можно выбрать режим работы
- **Будущеустойчивость** - работает с любыми версиями Vite
