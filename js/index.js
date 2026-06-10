const puasedstatus = document.querySelector('.pause-status');
const puasedIcon = document.querySelector('.pause-icon');
const orb = document.querySelector('.orb');

const typeBar = document.querySelector('.type-bar');
const textToggle = document.getElementById('textToggle');
const typeInput = document.querySelector('.type-input');

let micOn = false;
let stream;
let audioContext;
let analyser;
let dataArray;
let animationFrame;
let currentScale = 1;

// Toggle microphone by clicking the orb
orb.addEventListener('click', async () => {
    if (!micOn) {
        await startMic();
    } else {
        stopMic();
    }
});

async function startMic() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: true
        });

        audioContext = new AudioContext();

        const source = audioContext.createMediaStreamSource(stream);

        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        source.connect(analyser);

        dataArray = new Uint8Array(analyser.frequencyBinCount);

        micOn = true;

        // Fade out pause indicators
        puasedstatus.style.opacity = '0';
        puasedstatus.style.pointerEvents = 'none';

        puasedIcon.style.opacity = '0';
        puasedIcon.style.pointerEvents = 'none';

        animateOrb();

    } catch (err) {
        console.error('Failed to access microphone:', err);
    }
}

function stopMic() {
    micOn = false;

    cancelAnimationFrame(animationFrame);

    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }

    if (audioContext) {
        audioContext.close();
    }

    // Fade pause indicators back in
    puasedstatus.style.opacity = '1';
    puasedstatus.style.pointerEvents = '';

    puasedIcon.style.opacity = '0.35';
    puasedIcon.style.pointerEvents = '';

    currentScale = 1;
    orb.style.transform = 'scale(1)';
}

function animateOrb() {
    analyser.getByteTimeDomainData(dataArray);

    let sum = 0;

    for (let i = 0; i < dataArray.length; i++) {
        const value = (dataArray[i] - 128) / 128;
        sum += value * value;
    }

    // RMS volume
    const volume = Math.sqrt(sum / dataArray.length);

    // Small idle breathing effect
    const idle = Math.sin(Date.now() * 0.003) * 0.02;

    // Increase 6 for more sensitivity
    const targetScale = 1 + idle + volume * 6;

    // Smooth movement
    currentScale += (targetScale - currentScale) * 0.15;

    orb.style.transform = `scale(${currentScale})`;

    if (micOn) {
        animationFrame = requestAnimationFrame(animateOrb);
    }
}

// Text input toggle
textToggle.addEventListener('click', () => {
    const isOpen = typeBar.classList.toggle('is-open');

    textToggle.textContent = isOpen ? '< T' : 'T >';
    textToggle.setAttribute('aria-expanded', isOpen);

    if (isOpen) {
        typeInput.focus();
    } else {
        typeInput.blur();
    }
});