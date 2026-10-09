import './estilo/fontes.css';
import './estilo/base.css';
import './estilo/telas.css';
import { render } from 'preact';
import { App } from './app/App.jsx';

render(<App />, document.getElementById('app'));
