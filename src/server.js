const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const express = require('express');
const execFileAsync = promisify(execFile);

loadDotEnv(path.resolve(process.cwd(), '.env'));

const PORT = Number(process.env.PORT || 8091);
const FRONTEND_KEYWORD = process.env.FRONTEND_KEYWORD || '-frontend';
const NGINX_KEYWORDS = parseKeywordList(process.env.NGINX_KEYWORDS || '-nignx');
const DEFAULT_EXCLUDE_JOBS = process.env.DEFAULT_EXCLUDE_JOBS || '';
const NGINX_IMAGE_PARAM_NAME = process.env.NGINX_IMAGE_PARAM_NAME || 'IMAGE_NAME';
const NGINX_DEFAULT_IMAGE_NAME = process.env.NGINX_DEFAULT_IMAGE_NAME || '';
const LOCAL_GIT_ROOT = process.env.LOCAL_GIT_ROOT || '';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS || 30 * 60 * 1000);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.resolve(process.cwd(), 'public')));

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/views', asyncRoute(async (_req, res) => {
  const views = await listViews();
  res.json({ views });
}));

app.get('/api/config', (_req, res) => {
  res.json({
    defaultExcludeJobs: DEFAULT_EXCLUDE_JOBS,
  });
});

app.get('/api/views/:viewName/jobs', asyncRoute(async (req, res) => {
  const viewName = req.params.viewName;
  const excludeKeywords = parseExcludeInput(req.query.exclude || '');
  const jobs = await listViewJobs(viewName, excludeKeywords);
  res.json(jobs);
}));

app.post('/api/trigger', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const viewName = typeof body.viewName === 'string' ? body.viewName.trim() : '';
  const selectedJobs = Array.isArray(body.jobs) ? body.jobs : [];
  const selectedNginxJob = typeof body.selectedNginxJob === 'string' ? body.selectedNginxJob.trim() : '';
  const nginxImageName = typeof body.nginxImageName === 'string' ? body.nginxImageName.trim() : '';
  const keepExistingImageVersion = body.keepExistingImageVersion === true;
  const createGitTags = body.createGitTags === true;
  const excludeKeywords = parseExcludeInput(body.excludeJobs);

  if (!viewName) {
    throw createHttpError('viewName is required.', 400);
  }

  const result = await orchestrateViewBuild({
    viewName,
    selectedJobs,
    selectedNginxJob,
    nginxImageName,
    keepExistingImageVersion,
    createGitTags,
    excludeKeywords,
  });
  res.status(202).json(result);
}));

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({
    ok: false,
    error: error.message || 'Unexpected server error',
    details: error.details || null,
  });
});

app.listen(PORT, () => {
  console.log(`Jenkins orchestrator UI listening on http://localhost:${PORT}`);
});

async function listViews() {
  const client = await createJenkinsClient();
  const data = await jenkinsGetJson(client, '/api/json?tree=views[name]');
  const views = (data.views || [])
    .map((v) => v.name)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return views;
}

async function listViewJobs(viewName, excludeKeywords = []) {
  const client = await createJenkinsClient();
  const viewPath = `view/${encodeURIComponent(viewName)}`;
  const data = await jenkinsGetJson(client, `/${viewPath}/api/json?tree=jobs[name,fullName,url]`);

  const jobs = (data.jobs || []).map((job) => ({
    name: job.name,
    fullName: job.fullName || job.name,
    url: job.url || null,
  }));

  const excludedJobs = jobs.filter((job) => isJobExcluded(job, excludeKeywords));
  const eligibleJobs = jobs.filter((job) => !isJobExcluded(job, excludeKeywords));
  const isNginxJob = (job) => NGINX_KEYWORDS.some((kw) => job.fullName.includes(kw));
  const allFrontendJobs = jobs.filter((job) => (
    job.fullName.includes(FRONTEND_KEYWORD) && !isNginxJob(job)
  ));
  const frontendJobs = eligibleJobs.filter((job) => (
    job.fullName.includes(FRONTEND_KEYWORD) && !isNginxJob(job)
  ));
  const nginxJobs = eligibleJobs.filter((job) => isNginxJob(job));

  return {
    viewName,
    frontendKeyword: FRONTEND_KEYWORD,
    nginxKeywords: NGINX_KEYWORDS,
    excludedKeywords: excludeKeywords,
    excludedJobs: excludedJobs.map((job) => job.fullName),
    frontendFilteredCount: frontendJobs.length,
    frontendTotalCount: allFrontendJobs.length,
    frontendJobs,
    nginxJobs,
  };
}

async function orchestrateViewBuild({
  viewName,
  selectedJobs,
  selectedNginxJob = '',
  nginxImageName = '',
  keepExistingImageVersion = false,
  createGitTags = false,
  excludeKeywords = [],
}) {
  const normalizedSelected = normalizeSelectedJobs(selectedJobs);
  if (!normalizedSelected.length) {
    throw createHttpError('At least one frontend job must be selected.', 400);
  }

  const viewJobs = await listViewJobs(viewName, excludeKeywords);
  const allowedFrontend = new Set(viewJobs.frontendJobs.map((job) => job.fullName));

  const invalid = normalizedSelected.filter((job) => !allowedFrontend.has(job));
  if (invalid.length) {
    throw createHttpError('Selected jobs contain invalid frontend entries for the chosen view.', 400, { invalid });
  }

  const client = await createJenkinsClient();
  const selectedJobGitInfos = await Promise.all(
    normalizedSelected.map((jobFullName) => collectJobGitInfo(client, jobFullName)),
  );

  const frontendResults = await Promise.all(
    normalizedSelected.map((jobFullName) => runJobAndWait(client, jobFullName)),
  );

  const failedFrontend = frontendResults.filter((r) => r.result !== 'SUCCESS');
  if (failedFrontend.length) {
    throw createHttpError('Some frontend builds failed. Skipping nginx builds.', 409, {
      frontendResults,
      skippedNginx: viewJobs.nginxJobs.map((job) => job.fullName),
    });
  }

  const nginxTargets = viewJobs.nginxJobs.map((job) => job.fullName);
  let nginxToRun = [];
  let resolvedNginxJob = '';
  let nginxSelectionFallback = false;
  if (nginxTargets.length) {
    if (selectedNginxJob && nginxTargets.includes(selectedNginxJob)) {
      resolvedNginxJob = selectedNginxJob;
    } else {
      resolvedNginxJob = nginxTargets[0];
      nginxSelectionFallback = true;
    }
    nginxToRun = [resolvedNginxJob];
  }
  const nginxResults = await Promise.all(
    nginxToRun.map(async (jobFullName) => {
      const resolvedImageName = await resolveNginxImageName(
        client,
        jobFullName,
        nginxImageName,
        keepExistingImageVersion,
      );
      const buildParameters = { [NGINX_IMAGE_PARAM_NAME]: resolvedImageName };
      try {
        let result;
        let triggerMode = 'buildWithParameters';
        let configUpdate = { updated: false, reason: 'not attempted yet' };

        try {
          result = await runJobAndWait(client, jobFullName, buildParameters);
        } catch (paramError) {
          // Some Jenkins jobs reject /buildWithParameters even when IMAGE_NAME is logically used.
          // In that case, persist IMAGE_NAME in config.xml first and trigger plain /build.
          if ([400, 404, 500].includes(paramError.statusCode || 0)) {
            configUpdate = await updateNginxImageInJobConfig(client, jobFullName, resolvedImageName);
            result = await runJobAndWait(client, jobFullName, null);
            triggerMode = 'build';
          } else {
            throw paramError;
          }
        }

        // Keep config in sync even when parameterized trigger succeeded.
        if (!configUpdate.updated) {
          configUpdate = await updateNginxImageInJobConfig(client, jobFullName, resolvedImageName);
        }

        return {
          ...result,
          imageName: resolvedImageName,
          triggerMode,
          configUpdated: configUpdate.updated,
          configUpdateDetails: configUpdate,
        };
      } catch (error) {
        throw createHttpError(
          error.message || 'Failed to run nginx job',
          error.statusCode || 500,
          {
            ...error.details,
            nginxJob: jobFullName,
            resolvedImageName,
            imageParamName: NGINX_IMAGE_PARAM_NAME,
          },
        );
      }
    }),
  );

  let gitTagResults = [];
  if (createGitTags) {
    if (!LOCAL_GIT_ROOT) {
      throw createHttpError('LOCAL_GIT_ROOT is required when createGitTags is true.', 400);
    }
    const imageVersion = extractImageVersion(nginxResults?.[0]?.imageName || '');
    if (!imageVersion) {
      throw createHttpError('Cannot extract image version for git tag creation.', 400);
    }

    gitTagResults = await Promise.all(
      selectedJobGitInfos.map((info) => createGitTagForJob(info, imageVersion)),
    );
  }

  return {
    ok: true,
    viewName,
    excludedKeywords: excludeKeywords,
    frontendJobs: normalizedSelected,
    selectedJobGitInfos,
    frontendResults,
    nginxJobs: nginxToRun,
    selectedNginxJob: resolvedNginxJob || null,
    keepExistingImageVersion,
    createGitTags,
    nginxSelectionFallback,
    nginxResults,
    gitTagResults,
  };
}

async function runJobAndWait(client, jobFullName, buildParameters = null) {
  const queueUrl = await triggerJob(client, jobFullName, buildParameters);
  const executable = await waitForExecutable(client, queueUrl, JOB_TIMEOUT_MS);
  let appliedParameters = {};
  if (buildParameters && Object.keys(buildParameters).length > 0) {
    appliedParameters = await fetchBuildParametersFromBuildUrl(client, executable.url);
    validateAppliedParameters(jobFullName, buildParameters, appliedParameters);
  }
  const build = await waitForBuildResult(client, executable.url, JOB_TIMEOUT_MS);

  return {
    job: jobFullName,
    queueUrl,
    buildUrl: executable.url,
    buildNumber: executable.number,
    appliedParameters,
    result: build.result,
  };
}

async function triggerJob(client, jobFullName, buildParameters = null) {
  const baseJobPath = `/${toJenkinsJobPath(jobFullName)}`;

  if (buildParameters && Object.keys(buildParameters).length > 0) {
    const params = new URLSearchParams(buildParameters);
    const withParams = await jenkinsRequest(
      client,
      `${baseJobPath}/buildWithParameters?${params.toString()}`,
      { method: 'POST', withCrumb: true },
    );

    if (!withParams.ok) {
      const text = await withParams.text();
      throw createHttpError(
        `Failed to trigger job ${jobFullName} via buildWithParameters (${withParams.status}). ${text.slice(0, 300)}`,
        withParams.status,
      );
    }

    const locationWithParams = withParams.headers.get('location');
    if (!locationWithParams) {
      throw createHttpError(`Jenkins did not return queue location for ${jobFullName}.`, 502);
    }

    return normalizeToClientBase(client, absolutizeUrl(client.baseUrl, locationWithParams));
  }

  const firstTry = await jenkinsRequest(client, `${baseJobPath}/build`, { method: 'POST', withCrumb: true });

  let response = firstTry;
  let fallbackUsed = false;

  // Parameterized jobs often reject /build with 400 and require /buildWithParameters.
  if (firstTry.status === 400) {
    response = await jenkinsRequest(client, `${baseJobPath}/buildWithParameters`, { method: 'POST', withCrumb: true });
    fallbackUsed = true;
  }

  if (!response.ok) {
    const text = await response.text();
    const endpointHint = fallbackUsed ? 'buildWithParameters' : 'build';
    throw createHttpError(
      `Failed to trigger job ${jobFullName} via ${endpointHint} (${response.status}). ${text.slice(0, 300)}`,
      response.status,
    );
  }

  const location = response.headers.get('location');
  if (!location) {
    throw createHttpError(`Jenkins did not return queue location for ${jobFullName}.`, 502);
  }

  return normalizeToClientBase(client, absolutizeUrl(client.baseUrl, location));
}

async function waitForExecutable(client, queueUrl, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const queueApiUrl = `${queueUrl.replace(/\/$/, '')}/api/json?tree=cancelled,executable[number,url],why`;
    const queue = await jenkinsGetJson(client, queueApiUrl);

    if (queue.cancelled) {
      throw createHttpError(`Queue item cancelled. ${queue.why || ''}`.trim(), 409);
    }

    if (queue.executable && queue.executable.url) {
      return {
        number: queue.executable.number,
        url: queue.executable.url,
      };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw createHttpError(`Timed out waiting for queued build to start (${Math.round(timeoutMs / 1000)}s).`, 504);
}

async function waitForBuildResult(client, buildUrl, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const buildApiUrl = `${buildUrl.replace(/\/$/, '')}/api/json?tree=building,result`;
    const build = await jenkinsGetJson(client, buildApiUrl);

    if (!build.building) {
      return { result: build.result || 'UNKNOWN' };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw createHttpError(`Timed out waiting for build result (${Math.round(timeoutMs / 1000)}s).`, 504);
}

async function createJenkinsClient() {
  const config = getJenkinsConfig();
  const baseUrl = config.url.replace(/\/$/, '');
  const authHeader = `Basic ${Buffer.from(`${config.user}:${config.apiToken}`).toString('base64')}`;
  const crumb = await getCrumb(baseUrl, authHeader);

  return {
    baseUrl,
    authHeader,
    crumb,
  };
}

async function getCrumb(baseUrl, authHeader) {
  const response = await fetch(`${baseUrl}/crumbIssuer/api/json`, {
    headers: { Authorization: authHeader },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Failed to get Jenkins crumb (${response.status}). ${text.slice(0, 300)}`, response.status);
  }

  const data = await response.json();
  return {
    field: data.crumbRequestField,
    value: data.crumb,
  };
}

async function jenkinsGetJson(client, pathOrUrl) {
  const response = await jenkinsRequest(client, pathOrUrl);

  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Jenkins API request failed (${response.status}). ${text.slice(0, 300)}`, response.status);
  }

  return response.json();
}

function jenkinsRequest(client, pathOrUrl, options = {}) {
  const method = options.method || 'GET';
  const withCrumb = Boolean(options.withCrumb);
  const url = normalizeToClientBase(client, pathOrUrl);
  const body = options.body;

  const headers = {
    Authorization: client.authHeader,
    ...(options.headers || {}),
  };

  if (withCrumb && client.crumb) {
    headers[client.crumb.field] = client.crumb.value;
  }

  return fetch(url, {
    method,
    headers,
    body,
  });
}

function getJenkinsConfig() {
  const url = process.env.JENKINS_URL;
  const user = process.env.JENKINS_USER;
  const apiToken = process.env.JENKINS_API_TOKEN;

  if (!url || !user || !apiToken) {
    throw createHttpError(
      'Missing Jenkins configuration. Set JENKINS_URL, JENKINS_USER, JENKINS_API_TOKEN.',
      500,
    );
  }

  return {
    url,
    user,
    apiToken,
  };
}

function toJenkinsJobPath(jobName) {
  return `job/${jobName
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/job/')}`;
}

function normalizeSelectedJobs(selectedJobs) {
  return Array.from(
    new Set(
      (Array.isArray(selectedJobs) ? selectedJobs : [])
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter(Boolean),
    ),
  );
}

function parseKeywordList(raw) {
  return raw
    .split(',')
    .map((kw) => kw.trim())
    .filter(Boolean);
}

function parseExcludeInput(input) {
  if (typeof input === 'string') {
    return parseKeywordList(input);
  }

  if (Array.isArray(input)) {
    return input
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean);
  }

  return [];
}

function isJobExcluded(job, excludeKeywords) {
  if (!excludeKeywords.length) return false;
  return excludeKeywords.some((kw) => job.fullName.includes(kw) || job.name.includes(kw));
}

async function resolveNginxImageName(client, jobFullName, manualImageName, keepExistingImageVersion = false) {
  if (manualImageName) {
    return manualImageName;
  }

  const previous = await findPreviousImageName(client, jobFullName);
  const fromJobConfig = await findImageNameFromJobConfig(client, jobFullName);
  const base = previous || fromJobConfig || NGINX_DEFAULT_IMAGE_NAME;
  if (!base) {
    throw createHttpError(
      `Cannot resolve ${NGINX_IMAGE_PARAM_NAME} from previous build or pipeline config.`,
      400,
    );
  }

  if (keepExistingImageVersion) {
    return base;
  }

  return bumpPatchVersion(base);
}

async function findPreviousImageName(client, jobFullName) {
  const jobPath = `/${toJenkinsJobPath(jobFullName)}`;
  const lastSuccess = await fetchBuildParameters(client, `${jobPath}/lastSuccessfulBuild`);
  if (lastSuccess[NGINX_IMAGE_PARAM_NAME]) {
    return String(lastSuccess[NGINX_IMAGE_PARAM_NAME]);
  }

  const lastBuild = await fetchBuildParameters(client, `${jobPath}/lastBuild`);
  if (lastBuild[NGINX_IMAGE_PARAM_NAME]) {
    return String(lastBuild[NGINX_IMAGE_PARAM_NAME]);
  }

  return '';
}

async function fetchBuildParameters(client, buildBasePath) {
  const apiPath = `${buildBasePath}/api/json?tree=actions[parameters[name,value]]`;
  const response = await jenkinsRequest(client, apiPath);
  if (response.status === 404) {
    return {};
  }
  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Jenkins API request failed (${response.status}). ${text.slice(0, 300)}`, response.status);
  }

  const data = await response.json();
  const params = {};
  for (const action of data.actions || []) {
    for (const param of action.parameters || []) {
      if (param?.name) {
        params[param.name] = param.value;
      }
    }
  }
  return params;
}

async function findImageNameFromJobConfig(client, jobFullName) {
  const jobPath = `/${toJenkinsJobPath(jobFullName)}`;
  const response = await jenkinsRequest(client, `${jobPath}/config.xml`);
  if (response.status === 404) {
    return '';
  }
  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Jenkins config.xml request failed (${response.status}). ${text.slice(0, 300)}`, response.status);
  }

  const rawXml = await response.text();
  const xml = decodeXmlEntities(rawXml);

  // 1) String parameter default (if IMAGE_NAME is parameterized)
  const paramMatch = xml.match(
    new RegExp(`<name>\\s*${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*</name>[\\s\\S]*?<defaultValue>([^<]+)</defaultValue>`, 'i'),
  );
  if (paramMatch && paramMatch[1]) {
    return paramMatch[1].trim();
  }

  // 2) Declarative pipeline environment assignment (e.g. IMAGE_NAME='...:1.0.0')
  const envMatch = xml.match(
    new RegExp(`${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*=\\s*['"]([^'"]+)['"]`, 'i'),
  );
  if (envMatch && envMatch[1]) {
    return envMatch[1].trim();
  }

  return '';
}

async function updateNginxImageInJobConfig(client, jobFullName, newImageName) {
  const jobPath = `/${toJenkinsJobPath(jobFullName)}`;
  const getResponse = await jenkinsRequest(client, `${jobPath}/config.xml`);
  if (!getResponse.ok) {
    const text = await getResponse.text();
    throw createHttpError(`Failed to read job config.xml (${getResponse.status}). ${text.slice(0, 300)}`, getResponse.status);
  }

  const originalXml = await getResponse.text();
  let updatedXml = originalXml;
  let changed = false;

  // Update String parameter defaultValue (if IMAGE_NAME parameter is defined).
  const paramPattern = new RegExp(
    `(<name>\\s*${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*</name>[\\s\\S]*?<defaultValue>)([^<]*)(</defaultValue>)`,
    'i',
  );
  if (paramPattern.test(updatedXml)) {
    updatedXml = updatedXml.replace(paramPattern, `$1${escapeXmlText(newImageName)}$3`);
    changed = true;
  }

  // Update pipeline script environment assignment if present (both plain and XML-escaped quotes).
  const scriptPatterns = [
    new RegExp(`(${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*=\\s*')([^']+)(')`, 'i'),
    new RegExp(`(${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*=\\s*")([^"]+)(")`, 'i'),
    new RegExp(`(${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*=\\s*&apos;)([^&<]+)(&apos;)`, 'i'),
    new RegExp(`(${escapeRegExp(NGINX_IMAGE_PARAM_NAME)}\\s*=\\s*&quot;)([^&<]+)(&quot;)`, 'i'),
  ];
  for (const pattern of scriptPatterns) {
    if (pattern.test(updatedXml)) {
      updatedXml = updatedXml.replace(pattern, `$1${escapeXmlText(newImageName)}$3`);
      changed = true;
      break;
    }
  }

  if (!changed || updatedXml === originalXml) {
    return {
      updated: false,
      reason: 'No IMAGE_NAME definition found in config.xml',
    };
  }

  const postResponse = await jenkinsRequest(client, `${jobPath}/config.xml`, {
    method: 'POST',
    withCrumb: true,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: updatedXml,
  });

  if (!postResponse.ok) {
    const text = await postResponse.text();
    throw createHttpError(`Failed to save job config.xml (${postResponse.status}). ${text.slice(0, 300)}`, postResponse.status);
  }

  return {
    updated: true,
    imageName: newImageName,
  };
}

async function fetchBuildParametersFromBuildUrl(client, buildUrl) {
  const apiPath = `${buildUrl.replace(/\/$/, '')}/api/json?tree=actions[parameters[name,value]]`;
  const response = await jenkinsRequest(client, apiPath);
  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Jenkins API request failed (${response.status}). ${text.slice(0, 300)}`, response.status);
  }

  const data = await response.json();
  const params = {};
  for (const action of data.actions || []) {
    for (const param of action.parameters || []) {
      if (param?.name) {
        params[param.name] = param.value;
      }
    }
  }
  return params;
}

function validateAppliedParameters(jobFullName, expected, actual) {
  for (const [key, value] of Object.entries(expected)) {
    if (String(actual[key] ?? '') !== String(value)) {
      throw createHttpError(
        `Triggered build does not contain expected parameter ${key} for ${jobFullName}.`,
        409,
        {
          expected,
          actual,
          hint: 'Ensure Jenkins job defines this parameter and pipeline uses params.<NAME>.',
        },
      );
    }
  }
}

function bumpPatchVersion(imageName) {
  const match = imageName.match(/^(.*:)(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw createHttpError(
      `Invalid ${NGINX_IMAGE_PARAM_NAME} format: ${imageName}. Expected x.x.x tag.`,
      400,
    );
  }

  const prefix = match[1];
  const major = Number(match[2]);
  const minor = Number(match[3]);
  const patch = Number(match[4]) + 1;
  return `${prefix}${major}.${minor}.${patch}`;
}

function decodeXmlEntities(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function escapeXmlText(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectJobGitInfo(client, jobFullName) {
  const xml = await getJobConfigXml(client, jobFullName);
  const repoUrl = extractRepoUrlFromConfigXml(xml);
  const branch = normalizeBranchName(extractBranchFromConfigXml(xml));

  if (!repoUrl) {
    throw createHttpError(`Cannot find repository URL in Jenkins job config: ${jobFullName}`, 400);
  }
  if (!branch) {
    throw createHttpError(`Cannot find branch in Jenkins job config: ${jobFullName}`, 400);
  }

  const repoName = extractRepoName(repoUrl);
  const localPath = path.join(LOCAL_GIT_ROOT || '', repoName);

  return {
    job: jobFullName,
    repoUrl,
    branch,
    repoName,
    localPath,
  };
}

async function getJobConfigXml(client, jobFullName) {
  const jobPath = `/${toJenkinsJobPath(jobFullName)}`;
  const response = await jenkinsRequest(client, `${jobPath}/config.xml`);
  if (!response.ok) {
    const text = await response.text();
    throw createHttpError(`Failed to read Jenkins config.xml for ${jobFullName} (${response.status}). ${text.slice(0, 300)}`, response.status);
  }
  return response.text();
}

function extractRepoUrlFromConfigXml(xml) {
  const decoded = decodeXmlEntities(xml);
  const scoped = decoded.match(/<userRemoteConfigs>[\s\S]*?<\/userRemoteConfigs>/i)?.[0] || decoded;
  const scopedUrl = scoped.match(/<url>\s*([^<\s]+)\s*<\/url>/i)?.[1];
  if (scopedUrl) return scopedUrl.trim();

  const genericUrl = decoded.match(/<url>\s*([^<\s]+)\s*<\/url>/i)?.[1];
  return genericUrl ? genericUrl.trim() : '';
}

function extractBranchFromConfigXml(xml) {
  const decoded = decodeXmlEntities(xml);
  const branchesBlock = decoded.match(/<branches>[\s\S]*?<\/branches>/i)?.[0] || decoded;
  const nameInBranches = branchesBlock.match(/<name>\s*([^<]+)\s*<\/name>/i)?.[1];
  if (nameInBranches) return nameInBranches.trim();

  const branchTag = decoded.match(/<branch>\s*([^<]+)\s*<\/branch>/i)?.[1];
  if (branchTag) return branchTag.trim();

  return '';
}

function normalizeBranchName(branchRaw) {
  if (!branchRaw) return '';
  let branch = branchRaw.trim();
  if (branch.startsWith('refs/heads/')) {
    branch = branch.slice('refs/heads/'.length);
  }
  if (branch.startsWith('*/')) {
    branch = branch.slice(2);
  }
  return branch;
}

function extractRepoName(repoUrl) {
  const trimmed = repoUrl.trim();
  const tail = trimmed.split('/').pop() || trimmed.split(':').pop() || '';
  return tail.replace(/\.git$/, '');
}

function extractImageVersion(imageName) {
  const m = imageName.match(/:(\d+\.\d+\.\d+)$/);
  return m ? m[1] : '';
}

async function createGitTagForJob(jobInfo, imageVersion) {
  const localPath = jobInfo.localPath;
  if (!LOCAL_GIT_ROOT) {
    throw createHttpError('LOCAL_GIT_ROOT is not set.', 400);
  }
  if (!fs.existsSync(localPath)) {
    throw createHttpError(`Local repository path not found: ${localPath}`, 400, { jobInfo });
  }

  const tagName = `${jobInfo.branch}_v${imageVersion}`;
  const branch = jobInfo.branch;

  await runGit(localPath, ['rev-parse', '--is-inside-work-tree']);
  await runGit(localPath, ['fetch', '--all', '--prune']);
  await runGit(localPath, ['checkout', branch]);
  await runGit(localPath, ['pull', '--ff-only']);

  const commitSha = (await runGit(localPath, ['rev-parse', 'HEAD'])).trim();
  const existing = (await runGit(localPath, ['tag', '--list', tagName])).trim();

  if (existing) {
    return {
      ...jobInfo,
      tagName,
      commitSha,
      created: false,
      reason: 'Tag already exists',
    };
  }

  await runGit(localPath, ['tag', tagName, commitSha]);
  await runGit(localPath, ['push', 'origin', tagName]);

  return {
    ...jobInfo,
    tagName,
    commitSha,
    created: true,
  };
}

async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 });
    return String(stdout || '');
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : '';
    throw createHttpError(`Git command failed (git -C ${cwd} ${args.join(' ')}): ${stderr.slice(0, 300)}`, 400);
  }
}

function absolutizeUrl(baseUrl, maybeRelativeUrl) {
  if (maybeRelativeUrl.startsWith('http://') || maybeRelativeUrl.startsWith('https://')) {
    return maybeRelativeUrl;
  }

  return `${baseUrl}${maybeRelativeUrl.startsWith('/') ? '' : '/'}${maybeRelativeUrl}`;
}

function normalizeToClientBase(client, pathOrUrl) {
  if (!pathOrUrl) return client.baseUrl;

  // Jenkins may return internal absolute URLs in queue/build APIs.
  // Force all follow-up API calls to configured base URL to keep auth consistent.
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    try {
      const parsed = new URL(pathOrUrl);
      return `${client.baseUrl}${parsed.pathname}${parsed.search}`;
    } catch {
      return pathOrUrl;
    }
  }

  return `${client.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createHttpError(message, statusCode, details = null) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;

    const value = line.slice(eq + 1).trim();
    process.env[key] = value;
  }
}
