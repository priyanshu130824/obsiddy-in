#!/usr/bin/env node

// Obsiddy In — Interactive Setup
// Run: node setup.js

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// --- Helpers ---

function rl() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface, question, fallback) {
  return new Promise(resolve => {
    const prompt = fallback ? `${question} [${fallback}]: ` : `${question}: `;
    iface.question(prompt, answer => {
      resolve(answer.trim() || fallback || '');
    });
  });
}

function listFolders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

function countMdFiles(dir) {
  try {
    let count = 0;
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) walk(path.join(d, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.md')) count++;
      }
    };
    walk(dir);
    return count;
  } catch {
    return 0;
  }
}

// --- Banner ---

function printBanner() {
  console.log('');
  console.log('  ┌─────────────────────────────────────┐');
  console.log('  │         OBSIDDY IN — Setup           │');
  console.log('  │   A homepage for your Obsidian vault  │');
  console.log('  └─────────────────────────────────────┘');
  console.log('');
}

// --- Vault Detection ---

function detectVaultPath() {
  // Walk up from __dirname looking for a .obsidian folder (strong signal)
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 5; i++) {
    dir = path.dirname(dir);
    if (fs.existsSync(path.join(dir, '.obsidian'))) {
      return dir;
    }
  }
  // Fallback: parent of parent (common case: vault/subfolder/obsiddy-in/)
  const twoUp = path.resolve(__dirname, '..', '..');
  if (listFolders(twoUp).length > 0) return twoUp;
  // Last resort: immediate parent
  return path.resolve(__dirname, '..');
}

// --- Main ---

async function main() {
  printBanner();

  const iface = rl();

  // 0. Vault path
  const detected = detectVaultPath();
  console.log('  ── Step 1 of 5: Vault Path ──');
  console.log('  The full path to your Obsidian vault folder.');
  if (detected) {
    console.log(`  Detected: ${detected}`);
  }
  const vaultPathInput = await ask(iface, '  Vault path', detected || '');

  const VAULT_ROOT = path.resolve(vaultPathInput);
  if (!fs.existsSync(VAULT_ROOT)) {
    console.log('');
    console.log(`  ⚠  "${VAULT_ROOT}" does not exist.`);
    console.log('     Check the path and run setup again.');
    iface.close();
    process.exit(1);
  }

  const folders = listFolders(VAULT_ROOT);
  console.log('');
  console.log(`  Vault: ${VAULT_ROOT}`);
  if (folders.length > 0) {
    console.log('  Folders found:');
    folders.forEach(f => {
      const count = countMdFiles(path.join(VAULT_ROOT, f));
      console.log(`    ${f}${count > 0 ? ` (${count} notes)` : ''}`);
    });
  }
  console.log('');

  // 1. Vault name
  const vaultDirName = path.basename(VAULT_ROOT);
  console.log('  ── Step 2 of 5: Vault Name ──');
  console.log('  This appears as the logo on your homepage.');
  const vaultName = await ask(iface, '  Vault name', vaultDirName);
  console.log('');

  // 2. Inbox folder
  console.log('  ── Step 3 of 5: Inbox Folder ──');
  console.log('  New notes you capture will be saved here.');
  const inboxFolder = await ask(iface, '  Inbox folder name', 'Inbox');

  // Validate or create
  const inboxPath = path.join(VAULT_ROOT, inboxFolder);
  if (!fs.existsSync(inboxPath)) {
    const create = await ask(iface, `  "${inboxFolder}" doesn't exist. Create it? (y/n)`, 'y');
    if (create.toLowerCase() === 'y') {
      fs.mkdirSync(inboxPath, { recursive: true });
      console.log(`  ✓ Created ${inboxFolder}/`);
    } else {
      console.log('  Skipped — you can create it later.');
    }
  } else {
    const count = countMdFiles(inboxPath);
    console.log(`  ✓ Found ${inboxFolder}/ (${count} notes)`);
  }
  console.log('');

  // 3. Memory folder
  console.log('  ── Step 4 of 5: Memory Folder ──');
  console.log('  Related notes will be surfaced from this folder.');
  const memoryFolder = await ask(iface, '  Memory folder name', 'Notes');

  const memoryPath = path.join(VAULT_ROOT, memoryFolder);
  if (!fs.existsSync(memoryPath)) {
    console.log(`  ⚠  "${memoryFolder}" doesn't exist yet.`);
    console.log('     Make sure it exists before starting the server.');
  } else {
    const count = countMdFiles(memoryPath);
    console.log(`  ✓ Found ${memoryFolder}/ (${count} notes)`);
  }
  console.log('');

  // 4. Port
  console.log('  ── Step 5 of 5: Port ──');
  console.log('  The server will run on this port (default works for most people).');
  const portStr = await ask(iface, '  Port number', '3117');
  const port = parseInt(portStr, 10) || 3117;
  console.log('');

  iface.close();

  // Build config
  const config = {
    vaultPath: VAULT_ROOT,
    vaultName,
    inboxFolder,
    memoryFolder,
    port,
    skipTags: ['clippings', 'learning', 'inbox', 'transcript']
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Summary
  console.log('  ┌─────────────────────────────────────┐');
  console.log('  │           Setup Complete!             │');
  console.log('  └─────────────────────────────────────┘');
  console.log('');
  console.log(`  Vault path:    ${config.vaultPath}`);
  console.log(`  Vault name:    ${config.vaultName}`);
  console.log(`  Inbox folder:  ${config.inboxFolder}`);
  console.log(`  Memory folder: ${config.memoryFolder}`);
  console.log(`  Port:          ${config.port}`);
  console.log('');
  console.log(`  Config saved to: config.json`);
  console.log('');
  console.log('  ── Next Steps ──');
  console.log('');
  console.log('  Start the server:');
  console.log('');
  console.log('    node server.js');
  console.log('');
  console.log(`  Then open http://localhost:${config.port} in your browser.`);
  console.log('');
  console.log('  Set it as your browser homepage for quick access.');
  console.log('');

  // Auto-start option (macOS only)
  if (os.platform() === 'darwin') {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const autostart = await ask(rl2, '  Auto-start on login? (macOS only) (y/n)', 'n');
    rl2.close();

    if (autostart.toLowerCase() === 'y') {
      installLaunchAgent(config.port);
    }
  }

  console.log('');
  console.log('  Happy noting! 📝');
  console.log('');
}

// --- macOS Launch Agent ---

function installLaunchAgent(port) {
  const nodePath = process.execPath;
  const serverPath = path.join(__dirname, 'server.js');
  const plistName = 'com.obsiddy-in.homepage.plist';
  const plistDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(plistDir, plistName);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.obsiddy-in.homepage</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/obsiddy-in.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/obsiddy-in.err</string>
</dict>
</plist>`;

  try {
    if (!fs.existsSync(plistDir)) fs.mkdirSync(plistDir, { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf-8');
    const { execSync } = require('child_process');
    execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
    console.log('');
    console.log(`  ✓ Auto-start installed. Server will start on login.`);
    console.log(`    To remove: launchctl unload ~/Library/LaunchAgents/${plistName}`);
  } catch (e) {
    console.log('');
    console.log(`  ⚠  Could not install auto-start: ${e.message}`);
    console.log(`     You can start manually with: node server.js`);
  }
}

main().catch(e => {
  console.error('Setup error:', e);
  process.exit(1);
});
