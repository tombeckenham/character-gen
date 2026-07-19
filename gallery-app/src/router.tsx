import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { GalleryContext, useGalleryData } from "./data.ts";
import { GridPage } from "./GridPage.tsx";
import { DetailPage } from "./DetailPage.tsx";

/** Root layout owns the single poll loop and provides the data to all routes. */
function RootLayout() {
  const data = useGalleryData();
  return (
    <GalleryContext.Provider value={data}>
      <Outlet />
    </GalleryContext.Provider>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: GridPage,
});

const detailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$identifier",
  component: DetailPage,
});

// Hash history: file:// has no server to rewrite paths, so routes live after #.
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, detailRoute]),
  history: createHashHistory(),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
