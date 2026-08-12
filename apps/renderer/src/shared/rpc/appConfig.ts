// AppConfig（グローバル設定）の読み書き。
// 複数 feature (settings / terminal / preview / voicevox / arcade) が別々の
// セクションを読み書きするため、wrapper と直列化キューを層をまたぐ単一物としてここに置く。
import type { AppConfig, LoadAppConfigResponse, SaveAppConfigResponse } from "@gozd/rpc";

import { rpc } from "./client";

export const rpcLoadAppConfig = () => rpc<LoadAppConfigResponse>("/appConfig/load", {});

const rpcSaveAppConfig = (config: AppConfig) =>
  rpc<SaveAppConfigResponse>("/appConfig/save", { config });

/**
 * AppConfig 更新を単一キューで直列化する load → mutate → save の RMW。
 *
 * terminal / preview / voicevox / arcade の各セクションは別々の呼び出し元
 * (registerThemeCommand / settings patch / useVoicevoxStore / useArcadeStore) が
 * それぞれ load → 自セクション mutate → save で更新する。これらが renderer 内で並行すると、
 * 双方が古い config を読んでから書くため後勝ちで他セクションの更新が巻き戻る。全更新を
 * このキューに通して直列化することで、各 mutate が直前の save 完了後の最新 config を読む。
 * VSCode の ConfigurationEditing が設定書き込みを Queue で直列化するのと同じ発想。
 *
 * cross-process (dev/stable 同時起動) の競合は対象外 (architecture.md の WARNING 参照)。
 * これは renderer 内の並行 save のみを直列化する。
 */
let appConfigQueue: Promise<unknown> = Promise.resolve();

export async function updateAppConfig(mutate: (config: AppConfig) => void): Promise<void> {
  const run = appConfigQueue.then(async () => {
    const loaded = await rpcLoadAppConfig();
    const config = loaded.config;
    mutate(config);
    await rpcSaveAppConfig(config);
  });
  // 1 件の失敗で後続を止めないため queue 自体は握って次に繋ぐ。
  // 失敗は呼び出し元が返り値 run を await して検知し notify する。
  appConfigQueue = run.catch(() => {});
  return run;
}
