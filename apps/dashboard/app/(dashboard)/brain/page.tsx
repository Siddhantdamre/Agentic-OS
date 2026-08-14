'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Brain, Search } from 'lucide-react';
import { SnippetCard, type BrainSnippetView } from '@/components/brain/SnippetCard';
import { SourceRow, type BrainSourceView } from '@/components/brain/SourceRow';

type BrainEntity = {
  entityType: string;
  entityId: string;
  title: string | null;
  snippet: string;
  stale: boolean;
  updatedAt: string;
};

type BrainPayload = {
  empty: boolean;
  canMutate: boolean;
  snippets: BrainSnippetView[];
  entities: BrainEntity[];
  sources: BrainSourceView[];
};

const EMPTY_PAYLOAD: BrainPayload = {
  empty: true,
  canMutate: false,
  snippets: [],
  entities: [],
  sources: [],
};

export default function BrainPage() {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<BrainPayload>(EMPTY_PAYLOAD);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/brain?q=${encodeURIComponent(q)}`);
      if (!res.ok) {
        setData(EMPTY_PAYLOAD);
        return;
      }
      const json = await res.json();
      setData({
        empty: Boolean(json.empty),
        canMutate: Boolean(json.canMutate),
        snippets: Array.isArray(json.snippets) ? json.snippets : [],
        entities: Array.isArray(json.entities) ? json.entities : [],
        sources: Array.isArray(json.sources) ? json.sources : [],
      });
    } catch {
      setData(EMPTY_PAYLOAD);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('q') || '';
    setQuery(q);
    void load(q);
  }, [load]);

  const onDeleted = (id: string) => {
    setData((prev) => {
      const snippets = prev.snippets.filter((s) => s.id !== id);
      const sources = prev.sources.filter((s) => s.id !== id);
      return {
        ...prev,
        snippets,
        sources,
        empty: snippets.length === 0 && prev.entities.length === 0 && sources.length === 0,
      };
    });
  };

  const onCorrected = (id: string, body: string) => {
    setData((prev) => ({
      ...prev,
      snippets: prev.snippets.map((s) => (s.id === id ? { ...s, snippet: body } : s)),
    }));
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-12">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center">
            <Brain className="w-5 h-5 text-amber-600" />
          </div>
          <div>
            <h1 className="text-3xl font-serif font-bold text-heading">Brain</h1>
            <p className="text-slate-500 text-sm mt-1">
              Search, cite, correct, and reindex org memory. Empty orgs stay empty — nothing is invented.
            </p>
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
        className="relative"
      >
        <Search className="w-4 h-4 text-slate-400 absolute left-4 top-3.5" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search memory — names, listings, sources"
          className="w-full pl-11 pr-4 py-3 rounded-2xl bg-white border border-cream-300 text-sm text-heading focus:outline-none focus:border-amber-500"
        />
      </form>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 bg-cream-200/50 rounded-2xl animate-pulse border border-cream-300" />
          ))}
        </div>
      ) : data.empty ? (
        <p className="text-sm text-slate-500 bg-white border border-cream-300 rounded-2xl p-6">
          No stored memory. This org has no snippets, entities, or sources yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <section className="lg:col-span-2 space-y-3">
            <h2 className="text-sm font-bold text-heading uppercase tracking-wider">Snippets</h2>
            {data.snippets.length === 0 ? (
              <p className="text-xs text-slate-500">No snippets match.</p>
            ) : (
              data.snippets.map((s) => (
                <SnippetCard
                  key={s.id}
                  snippet={s}
                  canMutate={data.canMutate}
                  onDeleted={onDeleted}
                  onCorrected={onCorrected}
                />
              ))
            )}
          </section>

          <div className="space-y-6">
            <section className="space-y-3">
              <h2 className="text-sm font-bold text-heading uppercase tracking-wider">Entities</h2>
              {data.entities.length === 0 ? (
                <p className="text-xs text-slate-500">No entities.</p>
              ) : (
                data.entities.map((e) => (
                  <div
                    key={`${e.entityType}:${e.entityId}`}
                    className="bg-white border border-cream-300 rounded-2xl p-4 space-y-1"
                  >
                    <p className="text-xs font-semibold text-heading">
                      {e.title || `${e.entityType} ${e.entityId}`}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500">
                      {e.entityType} · {e.entityId}
                    </p>
                    <p className="text-xs text-slate-700">{e.snippet}</p>
                    {e.stale && (
                      <span className="text-[10px] font-bold uppercase text-amber-800">stale</span>
                    )}
                  </div>
                ))
              )}
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-bold text-heading uppercase tracking-wider">Sources</h2>
              {data.sources.length === 0 ? (
                <p className="text-xs text-slate-500">No sources.</p>
              ) : (
                data.sources.map((s) => (
                  <SourceRow key={s.id} source={s} canMutate={data.canMutate} />
                ))
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
