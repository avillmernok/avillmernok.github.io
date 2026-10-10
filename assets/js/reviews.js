(function () {
    "use strict";

    const config = window.REVIEWS_CONFIG || {};
    const reviewsList = document.getElementById("reviews-list");
    const reviewForm = document.getElementById("review-form");
    const opinionField = document.getElementById("review-opinion");
    const characterCount = document.getElementById("review-character-count");
    const submitButton = document.getElementById("review-submit");
    const statusElement = document.getElementById("review-form-status");
    const turnstileContainer = document.getElementById("review-turnstile-container");

    let turnstileWidgetId = null;

    function normalizeText(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function createReviewElement(review) {
        const card = document.createElement("blockquote");
        card.className = "review-card";

        const text = document.createElement("p");
        text.textContent = `„${normalizeText(review.text)}”`;

        const author = document.createElement("footer");
        author.textContent = `— ${normalizeText(review.author)}`;

        card.append(text, author);
        return card;
    }

    function renderReviews(reviews) {
        if (!reviewsList) {
            return;
        }

        reviewsList.replaceChildren();

        if (!Array.isArray(reviews) || reviews.length === 0) {
            const emptyMessage = document.createElement("p");
            emptyMessage.textContent = "Még nem érkezett vélemény.";
            reviewsList.appendChild(emptyMessage);
            return;
        }

        reviews.forEach(function (review) {
            if (review && review.text && review.author) {
                reviewsList.appendChild(createReviewElement(review));
            }
        });
    }

    async function loadReviews() {
        if (!reviewsList) {
            return;
        }

        try {
            const response = await fetch("data/reviews.json", {
                cache: "no-store",
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                throw new Error(`A véleménylista nem tölthető be (${response.status}).`);
            }

            const reviews = await response.json();
            renderReviews(reviews);
        } catch (error) {
            console.error(error);
            reviewsList.replaceChildren();
            const errorMessage = document.createElement("p");
            errorMessage.className = "form-status error";
            errorMessage.textContent = "A vélemények betöltése most nem sikerült. Kérlek, frissítsd az oldalt.";
            reviewsList.appendChild(errorMessage);
        }
    }

    function setStatus(message, type) {
        if (!statusElement) {
            return;
        }

        statusElement.textContent = message;
        statusElement.className = "form-status";
        if (type) {
            statusElement.classList.add(type);
        }
    }

    function setSubmitting(isSubmitting) {
        if (!submitButton) {
            return;
        }

        submitButton.disabled = isSubmitting;
        submitButton.textContent = isSubmitting ? "Küldés..." : "Vélemény elküldése";
    }

    function updateCharacterCount() {
        if (opinionField && characterCount) {
            characterCount.textContent = String(opinionField.value.length);
        }
    }

    function resetTurnstile() {
        if (window.turnstile && turnstileWidgetId !== null) {
            window.turnstile.reset(turnstileWidgetId);
        }
    }

    function renderTurnstile() {
        if (!config.turnstileSiteKey || !turnstileContainer || !window.turnstile) {
            return;
        }

        turnstileWidgetId = window.turnstile.render(turnstileContainer, {
            sitekey: config.turnstileSiteKey,
            theme: "dark",
            language: "hu",
            callback: function () {
                if (statusElement && statusElement.textContent.includes("robotellenőrzés")) {
                    setStatus("", "");
                }
            },
            "expired-callback": function () {
                setStatus("A robotellenőrzés lejárt. Kérlek, végezd el újra.", "error");
            },
            "error-callback": function () {
                setStatus("A robotellenőrzés nem töltődött be. Frissítsd az oldalt, majd próbáld újra.", "error");
            }
        });
    }

    function loadTurnstile() {
        if (!config.turnstileSiteKey || !turnstileContainer) {
            return;
        }

        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        script.addEventListener("load", renderTurnstile);
        script.addEventListener("error", function () {
            setStatus("A robotellenőrzés nem tölthető be. Kérlek, próbáld újra később.", "error");
        });
        document.head.appendChild(script);
    }

    async function submitReview(event) {
        event.preventDefault();

        if (!reviewForm.reportValidity()) {
            return;
        }

        if (!config.apiUrl) {
            setStatus("A véleményküldő végpont még nincs beállítva. Töltsd ki az apiUrl értékét a reviews-config.js fájlban.", "error");
            return;
        }

        const formData = new FormData(reviewForm);
        const payload = {
            lastName: normalizeText(formData.get("lastName")),
            firstName: normalizeText(formData.get("firstName")),
            opinion: normalizeText(formData.get("opinion")),
            website: normalizeText(formData.get("website")),
            consent: formData.get("consent") === "on",
            turnstileToken: normalizeText(formData.get("cf-turnstile-response"))
        };

        setSubmitting(true);
        setStatus("Vélemény küldése...", "pending");

        try {
            const response = await fetch(config.apiUrl, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(payload)
            });

            let result = {};
            try {
                result = await response.json();
            } catch (_) {
                result = {};
            }

            if (!response.ok) {
                throw new Error(result.error || "A vélemény elküldése nem sikerült.");
            }

            reviewForm.reset();
            updateCharacterCount();
            resetTurnstile();
            setStatus("Köszönöm! A véleményed ellenőrzésre elküldtem. Jóváhagyás után fog megjelenni a weboldalon.", "success");
        } catch (error) {
            console.error(error);
            setStatus(error.message || "Hiba történt a vélemény elküldésekor.", "error");
            resetTurnstile();
        } finally {
            setSubmitting(false);
        }
    }

    loadReviews();
    loadTurnstile();

    opinionField?.addEventListener("input", updateCharacterCount);
    reviewForm?.addEventListener("submit", submitReview);
    reviewForm?.addEventListener("reset", function () {
        window.setTimeout(updateCharacterCount, 0);
        setStatus("", "");
        resetTurnstile();
    });
})();
