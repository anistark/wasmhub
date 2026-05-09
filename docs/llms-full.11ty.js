import fs from "node:fs";

export const data = {
    permalink: "/llms-full.txt",
    eleventyExcludeFromCollections: true,
};

function stripFrontmatter(raw) {
    if (!raw.startsWith("---")) return raw;
    const end = raw.indexOf("\n---", 3);
    if (end === -1) return raw;
    return raw.slice(end + 4).replace(/^\n+/, "");
}

export function render(data) {
    const config = data.libdocConfig;
    const pages = data.collections.all
        .filter((p) => p.data.title && p.url && p.inputPath && p.inputPath.endsWith(".md"))
        .sort((a, b) => {
            const ao = a.url === "/" ? -1 : (a.data.eleventyNavigation?.order ?? 999);
            const bo = b.url === "/" ? -1 : (b.data.eleventyNavigation?.order ?? 999);
            if (ao !== bo) return ao - bo;
            return a.url.localeCompare(b.url);
        });

    const parts = [
        `# ${config.siteTitle}`,
        "",
        `> ${config.siteDescription}`,
        "",
        `Source: ${config.productionUrl}`,
        `Repository: https://github.com/anistark/wasmhub`,
        "",
        "This file concatenates every documentation page as plain markdown, intended for LLM context ingestion.",
        "",
    ];

    for (const page of pages) {
        const raw = fs.readFileSync(page.inputPath, "utf-8");
        const body = stripFrontmatter(raw).trim();
        parts.push(
            "",
            "---",
            "",
            `# ${page.data.title}`,
            "",
            `URL: ${config.productionUrl}${page.url}`,
            "",
            body,
            "",
        );
    }

    return parts.join("\n");
}
