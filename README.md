# llm write review

---

## LM Studio のインストール

1. [LM Studio 公式サイト](https://lmstudio.ai/) からインストーラーをダウンロード
2. ダウンロードしたファイルをインストール
3. LM Studio で必要なモデルをダウンロードし、API サーバーを起動

---

## VS Code Extension のビルド方法

### 依存パッケージのインストール

```sh
npm install
```

### ビルド

```sh
npm run build
```

### パッケージ作成(VSIX ファイル生成)

```sh
npx vsce package
```

VS Code コマンドの `install from VSIX` を使用して vsix ファイルを読み込み。

### 開発用のビルド

```sh
npm run watch
```
