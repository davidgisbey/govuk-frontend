import { readFile } from 'node:fs/promises'
import { join } from 'path'

import { getFileSizes } from '@govuk-frontend/lib/files'
import { getStats, modulePaths } from '@govuk-frontend/stats'

/**
 * Posts the content of multiple diffs in parallel on the given GitHub issue
 *
 * @param {GithubActionContext} githubActionContext
 * @param {number} issueNumber
 * @param {DiffComment[]} diffs
 */
export async function commentDiffs(githubActionContext, issueNumber, diffs) {
  // Run the comments in parallel to avoid that an early one failing prevents the others
  // and use `allSettled` to avoid the promise rejecting on the first failure but wait
  // for everything to complete
  const results = await Promise.allSettled(
    diffs.map((diff) => commentDiff(githubActionContext, issueNumber, diff))
  )

  if (results.some((result) => result.status === 'rejected')) {
    throw new Error('Posting diff comment failed', {
      cause: results
    })
  }
}

/**
 * Posts the content of a diff as a comment on a GitHub issue
 *
 * @param {GithubActionContext} githubActionContext
 * @param {number} issueNumber
 * @param {DiffComment} diffComment
 */
export async function commentDiff(
  githubActionContext,
  issueNumber,
  { path, titleText, markerText }
) {
  // Read diff from previous step, defaulting to a little note if the diff is empty
  // Using `||` and not `??` as `readFile` will return `''` (so not `null` nor `undefined` that `??` handles)
  const diffText = (await readFile(path, 'utf8')) || 'No changes found.'

  // Add or update comment on PR
  try {
    await comment(githubActionContext, issueNumber, {
      markerText,
      titleText,
      // eslint-disable-next-line no-useless-concat
      bodyText: '```diff\n' + `${diffText}\n` + '```'
    })
  } catch {
    await comment(githubActionContext, issueNumber, {
      markerText,
      titleText,
      // Unfortunately the best we can do here is a link to the "Artifacts"
      // section as [the upload-artifact action doesn't provide the public
      // URL](https://github.com/actions/upload-artifact/issues/50) :'(
      bodyText: `The diff could not be posted as a comment. You can download it from the [workflow artifacts](${githubActionRunUrl(
        githubActionContext.context
      )}#artifacts).`
    })
  }
}

/**
 * Generates comment for stats
 *
 * @param {GithubActionContext} githubActionContext
 * @param {number} issueNumber
 * @param {DiffComment} statComment
 */
export async function commentStats(
  githubActionContext,
  issueNumber,
  { path, titleText, markerText }
) {
  const reviewAppURL = getReviewAppUrl(issueNumber)

  const distPath = join(path, 'dist')
  const packagePath = join(path, 'packages/govuk-frontend/dist/govuk')

  // File sizes
  const fileSizeTitle = '### File sizes'
  const fileSizeRows = [
    ...(await getFileSizes(join(distPath, '**/*.{css,js,mjs}'))),
    ...(await getFileSizes(join(packagePath, '*.{css,js,mjs}')))
  ]

  const fileSizeHeaders = ['File', 'Size']
  const fileSizeTable = renderTable(fileSizeHeaders, fileSizeRows)
  const fileSizeText = [fileSizeTitle, fileSizeTable].join('\n')

  // Module sizes
  const modulesTitle = '### Modules'
  const modulesRows = (await Promise.all(modulePaths.map(getStats))).map(
    ([modulePath, moduleSize]) => {
      const statsPath = `docs/stats/${modulePath.replace('mjs', 'html')}`
      const statsURL = new URL(statsPath, reviewAppURL)

      return [`[${modulePath}](${statsURL})`, moduleSize]
    }
  )

  const modulesHeaders = ['File', 'Size']
  const modulesTable = renderTable(modulesHeaders, modulesRows)
  const modulesFooter = `[View stats and visualisations on the review app](${reviewAppURL})`
  const modulesText = [modulesTitle, modulesTable, modulesFooter].join('\n')

  await comment(githubActionContext, issueNumber, {
    markerText,
    titleText,
    bodyText: [fileSizeText, modulesText].join('\n')
  })
}

/**
 * @param {GithubActionContext} githubContext - GitHub Action context
 * @param {number} issueNumber - The number of the issue/PR on which to post the comment
 * @param {object} comment
 * @param {string} comment.markerText - A unique marker used to identify the correct comment
 * @param {string} comment.titleText - The title of the comment
 * @param {string} comment.bodyText - The body of the comment
 */
export async function comment(
  { github, context, commit },
  issueNumber,
  { titleText, markerText, bodyText }
) {
  const marker = `<!-- ${markerText} -->`
  const body = [
    marker,
    `## ${titleText}`,
    bodyText,
    '\n---', // <hr> for a little extra separation from content
    renderCommentFooter({ context, commit })
  ].join('\n')

  let commentId

  /**
   * @satisfies {IssueCommentsListParams}
   */
  const issueParameters = {
    issue_number: issueNumber,
    owner: context.repo.owner,
    repo: context.repo.repo
  }

  /**
   * Finds the first issue comment for which the `matcher` function returns `true`
   *
   * {@link https://github.com/peter-evans/find-comment/blob/main/src/find.ts}
   */
  for await (const { data: comments } of github.paginate.iterator(
    github.rest.issues.listComments,
    issueParameters
  )) {
    const comment = comments.find((comment) => !!comment.body?.includes(marker))

    if (comment) {
      commentId = comment.id
    }
  }

  /**
   * Create GitHub issue comment
   *
   * Updates existing comment by ID if available
   */
  await (!commentId
    ? github.rest.issues.createComment({ ...issueParameters, body })
    : github.rest.issues.updateComment({
        ...issueParameters,
        body,
        comment_id: commentId
      }))
}

/**
 * @param {Pick<GithubActionContext, "context" | "commit">} githubActionContext
 * @returns {string} - The content for the footer
 */
function renderCommentFooter({ context, commit }) {
  return `[Action run](${githubActionRunUrl(context)}) for ${commit}`
}

/**
 * Renders a GitHub Markdown table.
 *
 * @param {string[]} headers - An array containing the table headers.
 * @param {string[][]} rows - An array of arrays containing the row data for the table.
 * @returns {string} The GitHub Markdown table as a string.
 */
function renderTable(headers, rows) {
  if (!rows.every((row) => row.length === headers.length)) {
    throw new Error(
      'All rows must have the same number of elements as the headers.'
    )
  }

  /**
   * @example
   * ```md
   * | File | Size |
   * ```
   */
  const headerRow = `| ${headers.join(' | ')} |`

  /**
   * @example
   * ```md
   * | --- | --- |
   * ```
   */
  const headerSeparator = `| ${Array(headers.length).fill('---').join(' | ')} |`

  /**
   * @example
   * ```md
   * | packages/govuk-frontend/dist/example.mjs | 100 KiB |
   * ```
   */
  const rowStrings = rows.map((row) => `| ${row.join(' | ')} |`)

  // Combine headers, header separator, and rows to form the table
  return `${[headerRow, headerSeparator, ...rowStrings].join('\n')}\n`
}

/**
 * Generates a URL to the GitHub action run
 *
 * @param {import('@actions/github').context} context - The context of the GitHub action
 * @returns {string} The URL to the "Artifacts" section of the given run
 */
function githubActionRunUrl(context) {
  const { runId, repo } = context

  return `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${runId}/attempts/${process.env.GITHUB_RUN_ATTEMPT}`
}

/**
 * @param {number} prNumber - The PR number
 * @param {string} path - URL path
 * @returns {URL} - The Review App preview URL
 */
function getReviewAppUrl(prNumber, path = '/') {
  return new URL(path, `https://govuk-frontend-pr-${prNumber}.herokuapp.com`)
}

/**
 * @typedef {object} GithubActionContext
 * @property {import('@octokit/rest').Octokit} github - The pre-authenticated Octokit provided by GitHub actions
 * @property {import('@actions/github').context} context - The context of the GitHub action
 * @property {string} commit - The SHA of the commit that triggered the action
 */

/**
 * @typedef {object} DiffComment
 * @property {string} path - The path of the file to post as a comment
 * @property {string} titleText - The title of the comment
 * @property {string} markerText - The marker to identify the comment
 */

/**
 * @typedef {import('@octokit/plugin-rest-endpoint-methods').RestEndpointMethodTypes["issues"]} IssuesEndpoint
 * @typedef {IssuesEndpoint["updateComment"]["parameters"]} IssueCommentUpdateParams
 * @typedef {IssuesEndpoint["listComments"]["parameters"]} IssueCommentsListParams
 */
