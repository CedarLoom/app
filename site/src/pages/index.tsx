import type { ReactNode } from 'react';
import Link from '@docusaurus/Link';
import CodeBlock from '@theme/CodeBlock';
import Heading from '@theme/Heading';
import Layout from '@theme/Layout';
import styles from './index.module.css';

const install = `git clone https://github.com/CedarLoom/app.git
cd app
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build`;

const run = `cd my-project
node ../app/packages/cli/bin/cedarloom.js doctor
node ../app/packages/app/bin/cedarloom-app.js`;

function Install(): ReactNode {
  return (
    <section className={styles.section}>
      <Heading as="h2" id="install">
        Install
      </Heading>
      <p>
        The app runs from a clone of its repository. You need Node.js 26, pnpm 12 and Git, and the{' '}
        <Link href="https://cedarloom.github.io/cedarloom/">cl-workflow plugin</Link> installed for the project you
        configure.
      </p>
      <CodeBlock language="bash">{install}</CodeBlock>
      <p>
        Then run the commands from the folder of your project. <code>doctor</code> checks that everything is in place;{' '}
        <code>cedarloom-app</code> opens the web UI.
      </p>
      <CodeBlock language="bash">{run}</CodeBlock>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout description="The CedarLoom app designs, checks and writes the workflow definitions of a project for the CedarLoom Claude Code plugins, through a command line and a local web UI.">
      <header className={styles.hero}>
        <div className="container">
          <Heading as="h1">CedarLoom app</Heading>
          <p className={styles.lead}>
            The CedarLoom app designs, checks and writes the workflow definitions of your project for the CedarLoom
            Claude Code plugins, through a command line and a local web UI. Every change is shown as a plan before it is
            applied and can be undone.
          </p>
          <div className={styles.actions}>
            <Link className="button button--primary button--lg" to="#install">
              Install
            </Link>
            <Link className="button button--secondary button--lg" to="/cli">
              Commands
            </Link>
          </div>
        </div>
      </header>
      <main className="container">
        <Install />
        <section className={styles.section}>
          <Heading as="h2">Two ways in</Heading>
          <ul className={styles.steps}>
            <li>
              <Link to="/cli">The command line</Link>: <code>cedarloom</code> (or <code>cloom</code>) lists, shows,
              validates, edits and generates workflow definitions, and lists and undoes runs.
            </li>
            <li>
              <Link to="/web-ui">The web UI</Link>: <code>cedarloom-app</code> starts a server on your computer and
              opens the same work in your browser.
            </li>
          </ul>
        </section>
      </main>
    </Layout>
  );
}
