/**
 * 模型端点数据的单一来源：所有组件经 provider_list 读（真宿主 = SQLite providers 表；
 * mock = mockRuntime 同源形状），前端不再直接渲染 fixtures 端点表（PLAN §9 命令形状一致）。
 * appState.model 语义 = 模型 **id**（provider 侧标识，submit_message 原样带给宿主）；
 * 展示名经 modelLabel 映射（见 PLAN §6.7 端点配置 —— DbProviderFactory 按 id 匹配）。
 */
import { useEffect, useState } from "react";
import { client } from "./client";
import type { ModelGroup, ModelInfo } from "../data/fixtures";

export interface ProviderModelEntry {
  id: string;
  name?: string;
  variants?: string[];
  inputPrice?: string;
  outputPrice?: string;
  contextWindow?: number;
  reasoning?: boolean;
  vision?: boolean;
  desc?: string;
  bench?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  key_ref: string | null;
  models: ProviderModelEntry[];
  last_check: number | null;
}

let cache: ProviderRow[] | null = null;
const subs = new Set<() => void>();
const bump = (): void => {
  for (const s of [...subs]) s();
};

/** 拉取端点表；失败返回 null 并保留旧缓存（UI 不因网络态崩空） */
export async function refreshProviders(): Promise<ProviderRow[] | null> {
  try {
    const r = (await client.invoke("provider_list", {})) as { providers: ProviderRow[] };
    cache = r.providers ?? [];
    bump();
    return cache;
  } catch {
    return cache;
  }
}

export function clearProviderCache(): void {
  cache = null;
  bump();
}

export function useProviders(): ProviderRow[] | null {
  const [, setV] = useState(0);
  useEffect(() => {
    const f = (): void => setV(v => v + 1);
    subs.add(f);
    if (cache === null) void refreshProviders();
    return () => {
      subs.delete(f);
    };
  }, []);
  return cache;
}

export function contextLabel(cw: number | undefined): string {
  if (!cw) return "—";
  return cw >= 1000 ? `${Math.round(cw / 1000)}K` : String(cw);
}

/** provider 行 → 模型选择器的分组（形状与 fixtures.MODELS 一致，UI 不区分来源） */
export function modelsToGroups(rows: ProviderRow[]): ModelGroup[] {
  return rows
    .filter(r => r.models.length > 0)
    .map(r => ({
      group: r.name,
      items: r.models.map(
        (m): ModelInfo => ({
          id: m.id,
          name: m.name ?? m.id,
          provider: r.name,
          inputPrice: m.inputPrice ?? "—",
          outputPrice: m.outputPrice ?? "—",
          context: contextLabel(m.contextWindow),
          reasoning: !!m.reasoning,
          vision: !!m.vision,
          starred: m.variants !== undefined ? true : undefined,
          desc: m.desc ?? "",
          bench: m.bench,
        }),
      ),
    }));
}

export function modelLabel(id: string): string {
  if (!cache) return id;
  for (const r of cache) {
    const hit = r.models.find(m => m.id === id);
    if (hit) return hit.name ?? id;
  }
  return id;
}

/** 宿主里没有当前选择时（首启/换端点），落到第一个真实模型；返回是否改了 */
export function ensureModelInProviders(current: string, pick: (id: string) => void): void {
  if (!cache || cache.length === 0) return;
  const ids = cache.flatMap(r => r.models.map(m => m.id));
  if (ids.length > 0 && !ids.includes(current)) pick(ids[0]);
}
