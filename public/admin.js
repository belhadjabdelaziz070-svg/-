const translations = {
  ar: {
    register: "تسجيل الآن",
    track: "تتبع طلبي",
    success: "تم تسجيل الطلب بنجاح."
  },
  fr: {
    register: "S'inscrire",
    track: "Suivre ma demande",
    success: "Demande enregistrée avec succès."
  }
};

const state = { language: "ar" };

function setLanguage(language) {
  state.language = language;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "ar" ? "rtl" : "ltr";

  document.querySelectorAll("[data-lang]").forEach((button) => {
    const isActive = button.dataset.lang === language;
    button.classList.toggle("active", isActive);
  });

  const langLabel = document.querySelector(".lang-button.active")?.dataset.lang;
  if (langLabel) {
    document.body.dataset.lang = langLabel;
  }
}

function showRegistrationSuccess(message, trackingNumber) {
  const alertBox = document.getElementById("registration-message");
  if (!alertBox) return;

  alertBox.classList.remove("hidden");
  alertBox.classList.add("success");
  alertBox.textContent = `${message}${trackingNumber ? ` رقم التتبع: ${trackingNumber}` : ""}`;
}

function showError(message) {
  const alertBox = document.getElementById("registration-message");
  if (!alertBox) return;

  alertBox.classList.remove("hidden");
  alertBox.classList.add("error");
  alertBox.textContent = message;
}

async function handleRegistration(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);

  const submitButton = form.querySelector(".submit-btn");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "جارٍ الإرسال...";
  }

  try {
    const response = await fetch("/api/register", {
      method: "POST",
      body: formData
    });

    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(payload.error || "Unable to submit the application.");
    }

    showRegistrationSuccess(payload.message || translations[state.language].success, payload.tracking_number);
    form.reset();
  } catch (error) {
    showError(error.message || "An error occurred while submitting the application.");
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "إرسال الطلب";
    }
  }
}

async function handleTracking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const trackingNumber = form.querySelector("input").value.trim();
  const resultBox = document.getElementById("tracking-result");

  if (!trackingNumber) {
    resultBox.className = "tracking-result error-state";
    resultBox.innerHTML = "<p>يرجى إدخال رقم التتبع.</p>";
    return;
  }

  try {
    const response = await fetch(`/api/tracking/${encodeURIComponent(trackingNumber)}`);
    const payload = await response.json();

    if (!response.ok || !payload.success) {
      throw new Error(payload.error || "Tracking number not found.");
    }

    const app = payload.data;
    const notifications = (app.notifications || []).slice(0, 4);
    const documents = (app.documents || []).slice(0, 4);

    resultBox.className = "tracking-result";
    resultBox.innerHTML = `
      <div class="tracking-card">
        <h3>معلومات الملف</h3>
        <div class="tracking-details">
          <div><span>رقم التتبع:</span><strong>${app.tracking_number}</strong></div>
          <div><span>الاسم:</span><strong>${app.first_name} ${app.last_name}</strong></div>
          <div><span>الحالة:</span><strong>${app.application_status}</strong></div>
          <div><span>نوع السكن:</span><strong>${app.housing_type}</strong></div>
          <div><span>الولاية:</span><strong>${app.wilaya}</strong></div>
          <div><span>آخر تحديث:</span><strong>${app.updated_at || app.created_at}</strong></div>
        </div>
      </div>
      <div class="tracking-card">
        <h3>آخر التحديثات</h3>
        <ul>
          ${notifications.length ? notifications.map((item) => `<li>${item.message}</li>`).join("") : "<li>لا توجد تحديثات حتى الآن.</li>"}
        </ul>
      </div>
      <div class="tracking-card">
        <h3>الوثائق المرفوعة</h3>
        <ul>
          ${documents.length ? documents.map((item) => `<li>${item.original_name}</li>`).join("") : "<li>لم يتم رفع وثائق بعد.</li>"}
        </ul>
      </div>
    `;
  } catch (error) {
    resultBox.className = "tracking-result error-state";
    resultBox.innerHTML = `<p>${error.message}</p>`;
  }
}

function bindFaqs() {
  document.querySelectorAll(".faq-item button").forEach((button) => {
    button.addEventListener("click", () => {
      const item = button.parentElement;
      item.classList.toggle("active");
    });
  });
}

function initLandingPage() {
  const registrationForm = document.getElementById("registration-form");
  const trackingForm = document.getElementById("tracking-form");

  if (registrationForm) {
    registrationForm.addEventListener("submit", handleRegistration);
  }

  if (trackingForm) {
    trackingForm.addEventListener("submit", handleTracking);
  }

  bindFaqs();

  document.querySelectorAll("[data-lang]").forEach((button) => {
    button.addEventListener("click", () => setLanguage(button.dataset.lang));
  });
}

document.addEventListener("DOMContentLoaded", initLandingPage);
