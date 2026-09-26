import { describe, expect, test } from "bun:test";
import { createPinia, setActivePinia } from "pinia";
import { useRepoStore } from "../../shared/repo";
import { ensureRepoRegistered } from "./ensureRepoRegistered";

describe("ensureRepoRegistered", () => {
  test("窓口の dir を開いても repo list にもプールにも載らない", async () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/a", repoName: "a", isGitRepo: false, worktrees: [] });
    store.setConciergeDir("/concierge");

    await ensureRepoRegistered({
      rootDir: "/concierge",
      openDir: "/concierge",
      repoName: "concierge",
      isGitRepo: false,
    });

    expect(store.poolDirs).toEqual(["/a"]);
    expect(store.dirOrder).toEqual(["/a"]);
    expect(store.buildAppStateSnapshot().sidebarRepos.map((r) => r.rootDir)).toEqual(["/a"]);
  });

  test("プールにあってアクティブな list に無い repo は、アクティブな list に載せる", async () => {
    setActivePinia(createPinia());
    const store = useRepoStore();
    store.addRepo({ rootDir: "/a", repoName: "a", isGitRepo: false, worktrees: [] });
    store.addRepoList("other");

    await ensureRepoRegistered({ rootDir: "/a", openDir: "/a", repoName: "a", isGitRepo: false });

    expect(store.dirOrder).toEqual(["/a"]);
  });
});
