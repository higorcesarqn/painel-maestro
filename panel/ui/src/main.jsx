import './styles/fonts.css';
import './styles/base.css';
import './styles/screens.css';
import { render } from 'preact';
import { App } from './app/App.jsx';

render(<App />, document.getElementById('app'));
