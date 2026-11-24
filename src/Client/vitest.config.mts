import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.test.ts'],
        alias: {
            vscode: new URL('./tests/unit/__mocks__/vscode.ts', import.meta.url).pathname,
        },
    },
});
