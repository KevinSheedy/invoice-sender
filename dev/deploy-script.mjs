// Pushes apps-script/ to Google and points the live web app at the new code, keeping its URL.
//   npm run deploy:script -- "what changed"
// Needs `npx clasp login` once, and a .clasp.json with your script ID (see README).
import { execFileSync } from 'node:child_process';

const description = process.argv.slice(2).join(' ') || 'Deployed from command line';
const run = (args, opts = {}) => execFileSync('npx', ['clasp', ...args], { encoding: 'utf8', ...opts });

console.log('Running tests…');
execFileSync('npm', ['test', '--silent'], { stdio: 'inherit' });

console.log('Pushing apps-script/ to Google…');
run(['push', '--force'], { stdio: 'inherit' });

// @HEAD is Google's built-in test deployment; the web app is the one pinned to a version.
const deployments = JSON.parse(run(['--json', 'deployments'])).filter(d => d.versionNumber);
if (deployments.length !== 1) {
  console.error(`Expected one web app deployment, found ${deployments.length}:`, deployments);
  console.error('Redeploy by hand with: npx clasp redeploy <deploymentId> -d "..."');
  process.exit(1);
}
const [live] = deployments;

console.log(`Updating web app deployment (currently version ${live.versionNumber})…`);
run(['redeploy', live.deploymentId, '-d', description], { stdio: 'inherit' });
console.log('Done. The web app URL is unchanged.');
