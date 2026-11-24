const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: __dirname,
            },
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin,
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': ['error', {
                checksVoidReturn: false,  // VS Code APIs take () => void, but async handlers are idiomatic
            }],
            '@typescript-eslint/await-thenable': 'error',
        },
    },
    {
        ignores: ['out/**', 'dist/**', 'server/**', '.vscode-test/**', '.vscode-test-web/**', 'node_modules/**', 'tests/**'],
    }
);