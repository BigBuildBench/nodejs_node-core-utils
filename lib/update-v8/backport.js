import path from 'node:path';
import {
  promises as fs
} from 'node:fs';

import { confirm } from '@inquirer/prompts';
import { ListrEnquirerPromptAdapter } from '@listr2/prompt-adapter-enquirer';

import { shortSha } from '../utils.js';

import { getCurrentV8Version } from './common.js';
import { forceRunAsync } from '../run.js';

export async function checkOptions(options) {
  if (options.sha.length > 1 && options.squash) {
    const wantSquash = await confirm({
      message: 'Squashing commits should be avoided if possible, because it ' +
        'can make git bisection difficult. Only squash commits if they would ' +
        'break the build when applied individually. Are you sure?',
      default: false
    });

    if (!wantSquash) {
      return true;
    }
  }
};

export function doBackport(options) {
  const todo = [
    getCurrentV8Version(),
    generatePatches()
  ];

  if (options.squash) {
    todo.push(applyPatches());
    if (options.bump !== false) {
      if (options.nodeMajorVersion < 9) {
        todo.push(incrementV8Version());
      } else {
        todo.push(incrementEmbedderVersion());
      }
    }
    todo.push(commitSquashedBackport());
  } else if (options.preserveOriginalAuthor) {
    todo.push(cherryPickV8Commits(options));
  } else {
    todo.push(applyAndCommitPatches());
  }

  return {
    title: 'V8 commit backport',
    task: (ctx, task) => {
      return task.newListr(todo);
    }
  };
};

function commitSquashedBackport() {
  return {
    title: 'Commit backport',
    task: async(ctx) => {
      const { patches } = ctx;
      const messageTitle = formatMessageTitle(patches);
      let messageBody;
      if (patches.length === 1) {
        const [patch] = patches;
        messageBody = formatMessageBody(patch, false);
      } else {
        messageBody = '';
        for (const patch of patches) {
          const formatted = formatMessageBody(patch, true);
          messageBody += formatted + '\n\n';
        }
      }
      await ctx.execGitNode('add', ['deps/v8']);
      await ctx.execGitNode('commit', ['-m', messageTitle, '-m', messageBody]);
    }
  };
};

const commitTask = (patch, extraArgs, trailers) => async(ctx) => {
  const messageTitle = formatMessageTitle([patch]);
  const messageBody = formatMessageBody(patch, false, trailers);
  await ctx.execGitNode('add', ['deps/v8']);
  await ctx.execGitNode('commit', [
    ...ctx.gpgSign, ...extraArgs,
    '-m', messageTitle, '-m', messageBody
  ]);
};

function amendHEAD(patch) {
  return {
    title: 'Amend/commit',
    task: async(ctx) => {
      let coAuthor;
      if (patch.hadConflicts) {
        const getGitConfigEntry = async(configKey) => {
          const output = await forceRunAsync('git', ['config', configKey], {
            ignoreFailure: false,
            captureStdout: true,
            spawnArgs: { cwd: ctx.nodeDir }
          });
          return output.trim();
        };
        await ctx.execGitNode('am', [...ctx.gpgSign, '--continue']);
        coAuthor = `\nCo-authored-by: ${
          await getGitConfigEntry('user.name')} <${
          await getGitConfigEntry('user.email')}>`;
      }
      await commitTask(patch, ['--amend'], coAuthor)(ctx);
    }
  };
}

function commitPatch(patch) {
  return {
    title: 'Commit patch',
    task: commitTask(patch)
  };
}

function formatMessageTitle(patches) {
  const action =
    patches.some(patch => patch.hadConflicts) ? 'backport' : 'cherry-pick';
  if (patches.length === 1) {
    return `deps: V8: ${action} ${shortSha(patches[0].sha)}`;
  } else if (patches.length === 2) {
    return `deps: V8: ${action} ${shortSha(patches[0].sha)} and ${
      shortSha(patches[1].sha)
    }`;
  } else if (patches.length === 3) {
    return `deps: V8: ${action} ${shortSha(patches[0].sha)}, ${
      shortSha(patches[1].sha)
    } and ${shortSha(patches[2].sha)}`;
  } else {
    return `deps: V8: ${action} ${patches.length} commits`;
  }
}

function formatMessageBody(patch, prefixTitle, trailers = '') {
  const indentedMessage = patch.message.replace(/\n/g, '\n    ');
  const body =
    'Original commit message:\n\n' +
    `    ${indentedMessage}\n\n` +
    `Refs: https://github.com/v8/v8/commit/${patch.sha}${trailers}`;

  if (prefixTitle) {
    const action = patch.hadConflicts ? 'Backport' : 'Cherry-pick';
    return `${action} ${shortSha(patch.sha)}.\n` + body;
  }
  return body;
}

function generatePatches() {
  return {
    title: 'Generate patches',
    task: async(ctx) => {
      const shas = ctx.sha;
      const fullShas = await Promise.all(
        shas.map(async(sha) => {
          const stdout = await ctx.execGitV8('rev-parse', sha);
          return stdout.trim();
        })
      );
      ctx.patches = await Promise.all(fullShas.map(async(sha) => {
        const [patch, message] = await Promise.all([
          ctx.execGitV8('format-patch', '--stdout', `${sha}^..${sha}`),
          ctx.execGitV8('log', '--format=%B', '-n', '1', sha)
        ]);
        return {
          sha,
          data: patch,
          message
        };
      }));
    }
  };
}

function applyPatches() {
  return {
    title: 'Apply patches to deps/v8',
    task: async(ctx, task) => {
      const { patches } = ctx;
      for (const patch of patches) {
        await applyPatch(ctx, task, patch);
      }
    }
  };
}

function applyAndCommitPatches() {
  return {
    title: 'Apply and commit patches to deps/v8',
    task: (ctx, task) => {
      return task.newListr(ctx.patches.map(applyPatchTask));
    }
  };
}

function cherryPickV8Commits() {
  return {
    title: 'Cherry-pick commit from V8 clone to deps/v8',
    task: (ctx, task) => {
      return task.newListr(ctx.patches.map(cherryPickV8CommitTask));
    }
  };
}

function applyPatchTask(patch) {
  return {
    title: `Commit ${shortSha(patch.sha)}`,
    task: (ctx, task) => {
      const todo = [
        {
          title: 'Apply patch',
          task: (ctx, task) => applyPatch(ctx, task, patch)
        }
      ];
      if (ctx.bump !== false) {
        if (ctx.nodeMajorVersion < 9) {
          todo.push(incrementV8Version());
        } else {
          todo.push(incrementEmbedderVersion());
        }
      }
      todo.push(commitPatch(patch));
      return task.newListr(todo);
    }
  };
}

function cherryPickV8CommitTask(patch) {
  return {
    title: `Commit ${shortSha(patch.sha)}`,
    task: (ctx, task) => {
      const todo = [
        {
          title: 'Cherry-pick',
          task: (ctx, task) => applyPatch(ctx, task, patch, 'am')
        }
      ];
      if (ctx.bump !== false) {
        if (ctx.nodeMajorVersion < 9) {
          todo.push(incrementV8Version());
        } else {
          todo.push(incrementEmbedderVersion());
        }
      }
      todo.push(amendHEAD(patch));
      return task.newListr(todo);
    }
  };
}

async function applyPatch(ctx, task, patch, method = 'apply') {
  try {
    await ctx.execGitNode(
      method,
      ['-p1', '--3way', '--directory=deps/v8'],
      patch.data /* input */
    );
  } catch (e) {
    patch.hadConflicts = true;
    return task.prompt(ListrEnquirerPromptAdapter).run({
      type: 'input',
      message: "Resolve merge conflicts and enter 'RESOLVED'",
      validate: value => value.toUpperCase() === 'RESOLVED'
    });
  }
}

function incrementV8Version() {
  return {
    title: 'Increment V8 version',
    task: async(ctx) => {
      const incremented = ++ctx.currentVersion.patch;
      const versionHPath = `${ctx.nodeDir}/deps/v8/include/v8-version.h`;
      let versionH = await fs.readFile(versionHPath, 'utf8');
      versionH = versionH.replace(
        /V8_PATCH_LEVEL (\d+)/,
        `V8_PATCH_LEVEL ${incremented}`
      );
      await fs.writeFile(versionHPath, versionH);
    }
  };
}

const embedderRegex = /'v8_embedder_string': '-node\.(\d+)'/;
function incrementEmbedderVersion() {
  return {
    title: 'Increment embedder version number',
    task: async(ctx) => {
      const commonGypiPath = path.join(ctx.nodeDir, 'common.gypi');
      const commonGypi = await fs.readFile(commonGypiPath, 'utf8');
      const embedderValue = parseInt(embedderRegex.exec(commonGypi)[1], 10);
      const embedderString = `'v8_embedder_string': '-node.${embedderValue +
        1}'`;
      await fs.writeFile(
        commonGypiPath,
        commonGypi.replace(embedderRegex, embedderString)
      );
      await ctx.execGitNode('add', ['common.gypi']);
    }
  };
}
