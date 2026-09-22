import { useMemo, useState } from "react";

interface ProjectItem {
  readonly id: string;
  readonly name: string;
}

interface DashboardFixture {
  readonly state: "populated" | "empty" | "loading" | "error" | "long-text";
  readonly items: readonly ProjectItem[];
  readonly error: string | null;
}

declare global {
  interface Window {
    readonly __BOXSPEC_FIXTURE__?: DashboardFixture;
  }
}

const defaultFixture: DashboardFixture = {
  state: "populated",
  items: [
    { id: "project-a", name: "첫 번째 프로젝트" },
    { id: "project-b", name: "Atlas 검색 프로젝트" },
    { id: "project-c", name: "브라우저 검증 작업" },
  ],
  error: null,
};

function ProjectList({ fixture, query }: { fixture: DashboardFixture; query: string }) {
  const items = useMemo(
    () => fixture.items.filter((item) => item.name.toLocaleLowerCase("ko").includes(query.trim().toLocaleLowerCase("ko"))),
    [fixture.items, query],
  );
  if (fixture.state === "loading") return <div className="state-message" role="status">프로젝트를 불러오는 중입니다.</div>;
  if (fixture.state === "error") return <div className="state-message error" role="alert">{fixture.error ?? "프로젝트를 불러오지 못했습니다."}</div>;
  if (items.length === 0) return <div className="state-message">표시할 프로젝트가 없습니다.</div>;
  return (
    <ul className="project-list" aria-label="프로젝트 목록">
      {items.map((item) => (
        <li key={item.id} className="project-row" data-testid="project-item">
          <span>{item.name}</span>
          <span className="project-status">Ready</span>
        </li>
      ))}
    </ul>
  );
}

export function App() {
  const fixture = window.__BOXSPEC_FIXTURE__ ?? defaultFixture;
  const [query, setQuery] = useState("");
  return (
    <div className="shell" data-boxspec-node="root">
      <header className="header" data-boxspec-node="header">
        <span className="wordmark">BoxSpec</span>
        <span className="screen-title">프로젝트 대시보드</span>
      </header>
      <div className="body" data-boxspec-node="body">
        <aside className="sidebar" data-boxspec-node="sidebar" aria-label="주 탐색">
          <strong>프로젝트</strong>
          <nav>
            <a href="#active" aria-current="page">최근 프로젝트</a>
            <a href="#archived">보관됨</a>
          </nav>
        </aside>
        <main className="main" data-boxspec-node="main">
          <div className="search" data-boxspec-node="search">
            <label htmlFor="project-search">프로젝트 검색</label>
            <input
              id="project-search"
              data-testid="project-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="이름으로 검색"
            />
          </div>
          <section className="projects" data-boxspec-node="projects" aria-label="프로젝트 결과">
            <ProjectList fixture={fixture} query={query} />
          </section>
        </main>
      </div>
    </div>
  );
}
