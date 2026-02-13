const viewSelectEl = document.getElementById('view-select');
const jobsEl = document.getElementById('frontend-jobs');
const formEl = document.getElementById('trigger-form');
const statusEl = document.getElementById('status');
const checkAllBtn = document.getElementById('check-all');
const clearAllBtn = document.getElementById('clear-all');
const reloadJobsBtn = document.getElementById('reload-jobs');
const nginxTargetsEl = document.getElementById('nginx-targets');
const nginxJobsEl = document.getElementById('nginx-jobs');
const excludeJobsEl = document.getElementById('exclude-jobs');
const nginxImageNameEl = document.getElementById('nginx-image-name');

let currentFrontendJobs = [];

init().catch((err) => {
  showStatus(`Failed to load views: ${err.message}`, true);
});

async function init() {
  const [viewsResponse, configResponse] = await Promise.all([
    fetch('/api/views'),
    fetch('/api/config'),
  ]);

  if (!viewsResponse.ok) {
    throw new Error(`HTTP ${viewsResponse.status}`);
  }
  if (!configResponse.ok) {
    throw new Error(`HTTP ${configResponse.status}`);
  }

  const viewsData = await viewsResponse.json();
  const configData = await configResponse.json();

  if (typeof configData.defaultExcludeJobs === 'string') {
    excludeJobsEl.value = configData.defaultExcludeJobs;
  }

  viewsData.views.forEach((viewName) => {
    const opt = document.createElement('option');
    opt.value = viewName;
    opt.textContent = viewName;
    viewSelectEl.appendChild(opt);
  });
}

viewSelectEl.addEventListener('change', async () => {
  await loadJobsForSelectedView();
});

reloadJobsBtn.addEventListener('click', async () => {
  await loadJobsForSelectedView();
});

async function loadJobsForSelectedView() {
  try {
    const viewName = viewSelectEl.value;
    jobsEl.innerHTML = '';
    nginxJobsEl.innerHTML = '';
    currentFrontendJobs = [];
    hideNginxTargets();

    if (!viewName) {
      showStatus('View를 선택하세요.', true);
      return;
    }

    showStatus('선택한 view의 job 목록을 불러오는 중...');

    const exclude = getExcludeJobsRaw();
    const query = exclude ? `?exclude=${encodeURIComponent(exclude)}` : '';
    const response = await fetch(`/api/views/${encodeURIComponent(viewName)}/jobs${query}`);
    const payload = await readJsonSafely(response);

    if (!response.ok) {
      const message = payload?.error || `Failed to load jobs (HTTP ${response.status})`;
      showStatus(message, true);
      return;
    }

    currentFrontendJobs = payload.frontendJobs || [];

    if (!currentFrontendJobs.length) {
      showStatus(`해당 view에 '${payload.frontendKeyword}'가 포함된 job이 없습니다.`, true);
    } else {
      currentFrontendJobs.forEach((job) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'frontend-job';
        input.value = job.fullName;
        label.appendChild(input);
        label.appendChild(document.createTextNode(job.fullName));
        jobsEl.appendChild(label);
      });
      showStatus(`Frontend 대상 ${currentFrontendJobs.length}개 로드 완료`);
    }

    if (payload.nginxJobs && payload.nginxJobs.length) {
      const names = payload.nginxJobs.map((j) => j.fullName).join(', ');
      nginxTargetsEl.style.display = 'block';
      nginxTargetsEl.textContent = `후속 Nignx 대상: ${names}`;

      payload.nginxJobs.forEach((job, idx) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'nginx-job';
        input.value = job.fullName;
        if (idx === 0) input.checked = true;
        label.appendChild(input);
        label.appendChild(document.createTextNode(job.fullName));
        nginxJobsEl.appendChild(label);
      });
    } else {
      showStatus(`Frontend 빌드 후 실행할 '-nignx' 대상이 없습니다.`);
    }
  } catch (error) {
    showStatus(`목록 조회 중 오류: ${error.message}`, true);
  }
}

formEl.addEventListener('submit', async (event) => {
  try {
    event.preventDefault();

    const viewName = viewSelectEl.value;
    if (!viewName) {
      showStatus('먼저 view를 선택하세요.', true);
      return;
    }

    const selectedJobs = Array.from(document.querySelectorAll('input[name="frontend-job"]:checked')).map((el) => el.value);
    if (!selectedJobs.length) {
      showStatus('최소 1개 이상의 frontend job을 선택하세요.', true);
      return;
    }
    let selectedNginx = document.querySelector('input[name="nginx-job"]:checked')?.value || '';
    if (!selectedNginx) {
      const firstNginx = document.querySelector('input[name="nginx-job"]');
      if (firstNginx) {
        firstNginx.checked = true;
        selectedNginx = firstNginx.value;
      }
    }

    showStatus('Jenkins 오케스트레이션 실행 중... (완료까지 대기)');

    const response = await fetch('/api/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        viewName,
        jobs: selectedJobs,
        selectedNginxJob: selectedNginx,
        nginxImageName: nginxImageNameEl.value.trim(),
        excludeJobs: getExcludeJobsRaw(),
      }),
    });

    const payload = await readJsonSafely(response);
    if (!response.ok || !payload?.ok) {
      const details = payload?.details ? `\n상세: ${JSON.stringify(payload.details, null, 2)}` : '';
      showStatus((payload?.error || `Request failed (HTTP ${response.status})`) + details, true);
      return;
    }

    const frontendLines = (payload.frontendResults || []).map((r) => `- ${r.job}: ${r.result}`);
    const nginxLines = (payload.nginxResults || []).map((r) => {
      const applied = r.appliedParameters?.IMAGE_NAME || r.imageName || 'IMAGE_NAME 미확인';
      const configSaved = r.configUpdated ? 'config 저장됨' : 'config 미변경';
      const mode = r.triggerMode || 'unknown';
      return `- ${r.job}: ${r.result} (${applied}, ${configSaved}, mode=${mode})`;
    });
    const excludedInfo = payload.excludedKeywords?.length
      ? `제외 키워드: ${payload.excludedKeywords.join(', ')}`
      : '제외 키워드: 없음';

    const lines = [
      '오케스트레이션 완료',
      `View: ${payload.viewName}`,
      excludedInfo,
      `선택된 Nignx: ${payload.selectedNginxJob || '없음'}`,
      ...(payload.nginxSelectionFallback ? ['Nignx 선택값이 없어 첫 번째 대상으로 자동 보정됨'] : []),
      'Frontend 결과:',
      ...(frontendLines.length ? frontendLines : ['- 없음']),
      'Nignx 결과:',
      ...(nginxLines.length ? nginxLines : ['- 없음']),
    ];

    showStatus(lines.join('\n'));
  } catch (error) {
    showStatus(`실행 중 오류: ${error.message}`, true);
  }
});

checkAllBtn.addEventListener('click', () => {
  document.querySelectorAll('input[name="frontend-job"]').forEach((el) => {
    el.checked = true;
  });
});

clearAllBtn.addEventListener('click', () => {
  document.querySelectorAll('input[name="frontend-job"]').forEach((el) => {
    el.checked = false;
  });
});

function hideNginxTargets() {
  nginxTargetsEl.style.display = 'none';
  nginxTargetsEl.textContent = '';
}

function getExcludeJobsRaw() {
  return excludeJobsEl.value.trim();
}

async function readJsonSafely(response) {
  const raw = await response.text();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`서버 응답 파싱 실패 (HTTP ${response.status})`);
  }
}

function showStatus(message, isError = false) {
  statusEl.style.display = 'block';
  statusEl.classList.toggle('error', isError);
  statusEl.textContent = message;
}
