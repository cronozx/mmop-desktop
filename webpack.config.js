import path from 'path';
import { fileURLToPath } from 'url';
import HtmlWebpackPlugin from 'html-webpack-plugin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProduction = process.env.NODE_ENV === 'production';

export default [
    // Renderer process.
    // Target `web` (not `electron-renderer`): the window is sandboxed
    // (nodeIntegration: false, sandbox: true), so Node builtins are never
    // available at runtime. `web` resolves browser builds of deps (e.g. vfile,
    // pulled in by react-markdown) instead of their Node builds that import
    // `node:path` and would externalize to a `require` that doesn't exist.
    {
        mode: isProduction ? 'production' : 'development',
        entry: './src/renderer/index.tsx',
        target: 'web',
        devtool: isProduction ? false : 'source-map',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'renderer.js'
        },
        watchOptions: {
            ignored: /node_modules/,
            aggregateTimeout: 300,
            poll: 1000
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    exclude: /node_modules/,
                    use: 'ts-loader'
                },
                {
                    test: /\.jsx?$/,
                    exclude: /node_modules/,
                    use: {
                        loader: 'babel-loader',
                        options: {
                            presets: ['@babel/preset-react']
                        }
                    }
                },
                {
                    test: /\.css$/,
                    use: ['style-loader', 'css-loader', 'postcss-loader']
                }
            ]
        },
        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.jsx'],
            extensionAlias: {
                '.js': ['.js', '.ts', '.tsx'],
            },
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: './src/renderer/index.html'
            })
        ]
    },
    // Preload script
    {
        mode: isProduction ? 'production' : 'development',
        entry: './preload.ts',
        target: 'electron-preload',
        devtool: isProduction ? false : 'source-map',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'preload.cjs'
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    exclude: /node_modules/,
                    use: 'ts-loader'
                }
            ]
        },
        resolve: {
            extensions: ['.ts', '.js'],
            extensionAlias: {
                '.js': ['.js', '.ts'],
            },
        }
    }
];