"use client";

import { type CSSProperties, useMemo, useState } from "react";
import { findPdfOutlineAncestorIds } from "./pdf-outline.mjs";

export type PdfOutlineItem = {
  id: string;
  title: string;
  pageNumber: number | null;
  tokenIndex: number | null;
  items: PdfOutlineItem[];
};

type DocumentOutlineProps = {
  items: PdfOutlineItem[];
  activeItemId: string | null;
  onNavigate: (item: PdfOutlineItem) => void;
};

function countOutlineItems(items: PdfOutlineItem[]): number {
  return items.reduce(
    (count, item) => count + 1 + countOutlineItems(item.items),
    0,
  );
}

function defaultExpandedIds(
  items: PdfOutlineItem[],
  activeItemId: string | null,
) {
  const firstGroup = items.find((item) => item.items.length)?.id;
  return new Set([
    ...(firstGroup ? [firstGroup] : []),
    ...findPdfOutlineAncestorIds(items, activeItemId),
  ]);
}

function OutlineList({
  items,
  depth,
  activeItemId,
  expandedIds,
  onToggle,
  onNavigate,
}: {
  items: PdfOutlineItem[];
  depth: number;
  activeItemId: string | null;
  expandedIds: Set<string>;
  onToggle: (itemId: string) => void;
  onNavigate: DocumentOutlineProps["onNavigate"];
}) {
  return (
    <ul className="document-outline-list">
      {items.map((item) => {
        const hasChildren = item.items.length > 0;
        const isExpanded = hasChildren && expandedIds.has(item.id);
        const isActive = item.id === activeItemId;
        const childrenId = `${item.id}-children`;
        const rowStyle = { "--outline-depth": depth } as CSSProperties;

        return (
          <li key={item.id}>
            <div
              className={`document-outline-row ${
                isActive ? "document-outline-row-active" : ""
              }`}
              style={rowStyle}
            >
              {hasChildren ? (
                <button
                  className="document-outline-toggle"
                  type="button"
                  aria-expanded={isExpanded}
                  aria-controls={childrenId}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${
                    item.title
                  }`}
                  onClick={() => onToggle(item.id)}
                >
                  <span aria-hidden="true">›</span>
                </button>
              ) : (
                <span className="document-outline-toggle-spacer" />
              )}

              {item.tokenIndex !== null ? (
                <button
                  className="document-outline-link"
                  type="button"
                  aria-current={isActive ? "location" : undefined}
                  onClick={() => onNavigate(item)}
                >
                  <span>{item.title}</span>
                  {item.pageNumber !== null && (
                    <small>Page {item.pageNumber}</small>
                  )}
                </button>
              ) : (
                <span className="document-outline-group-label">
                  <span>{item.title}</span>
                  <small>Section group</small>
                </span>
              )}
            </div>

            {isExpanded && (
              <div id={childrenId}>
                <OutlineList
                  items={item.items}
                  depth={depth + 1}
                  activeItemId={activeItemId}
                  expandedIds={expandedIds}
                  onToggle={onToggle}
                  onNavigate={onNavigate}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DocumentOutline({
  items,
  activeItemId,
  onNavigate,
}: DocumentOutlineProps) {
  const [expandedIds, setExpandedIds] = useState(() =>
    defaultExpandedIds(items, activeItemId),
  );
  const itemCount = useMemo(() => countOutlineItems(items), [items]);

  const toggleItem = (itemId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  return (
    <section
      className="document-outline-section"
      aria-labelledby="document-outline-title"
    >
      <div className="document-outline-heading">
        <p className="nav-label" id="document-outline-title">
          Contents
        </p>
        {itemCount > 0 && (
          <span>
            {itemCount} {itemCount === 1 ? "section" : "sections"}
          </span>
        )}
      </div>

      {items.length ? (
        <nav aria-label="Document table of contents">
          <OutlineList
            items={items}
            depth={0}
            activeItemId={activeItemId}
            expandedIds={expandedIds}
            onToggle={toggleItem}
            onNavigate={onNavigate}
          />
        </nav>
      ) : (
        <div className="document-outline-empty" role="status">
          <strong>No embedded contents</strong>
          <p>
            This PDF does not include a navigable outline. Use Bookmarks or
            document search to move around it.
          </p>
        </div>
      )}
    </section>
  );
}
