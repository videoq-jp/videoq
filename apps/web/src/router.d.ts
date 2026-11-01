import type { NavigateOptions, To } from 'react-router-dom';

// AppRoot uses BrowserRouter (declarative mode), whose navigate returns void.
declare module 'react-router' {
  interface NavigateFunction {
    (to: To, options?: NavigateOptions): void;
    (delta: number): void;
  }
}
