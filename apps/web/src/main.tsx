import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { AppRoot } from './AppRoot'
import './index.css'

const root = document.getElementById('root')!
const app = <AppRoot router={BrowserRouter} devtools={import.meta.env.DEV && <ReactQueryDevtools initialIsOpen={false} />} />

// Public pages arrive prerendered. Application routes use the empty shell.
if (root.hasChildNodes()) ReactDOM.hydrateRoot(root, app)
else ReactDOM.createRoot(root).render(app)
