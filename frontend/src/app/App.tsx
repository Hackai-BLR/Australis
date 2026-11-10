import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { AuthProvider } from "../shared/auth";
import { ToastProvider } from "../shared/ui";
import { appRoutes, routerFuture } from "./routes";

const router = createBrowserRouter(appRoutes, { future: routerFuture });

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </ToastProvider>
    </AuthProvider>
  );
}
