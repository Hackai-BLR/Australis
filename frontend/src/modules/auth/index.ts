// Public surface of the auth module. Other code imports only from here.
// Session state (AuthProvider, useAuth, guards) lives in src/shared/auth because every module
// needs it; this module owns the auth screens.
export { campusTabs, navItems, publicRoutes, routes } from "./routes";
