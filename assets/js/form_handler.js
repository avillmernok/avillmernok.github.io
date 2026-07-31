(function () {
    "use strict";

    const form = document.getElementById("contact-form");

    if (!form) {
        return;
    }

    form.addEventListener("submit", async function (event) {
        event.preventDefault();

        const submitButton = form.querySelector('[type="submit"]');
        const originalText = submitButton ? submitButton.value : "";

        if (submitButton) {
            submitButton.disabled = true;
            submitButton.value = "Küldés...";
        }

        try {
            const response = await fetch(form.action, {
                method: form.method,
                body: new FormData(form),
                headers: { "Accept": "application/json" }
            });

            if (!response.ok) {
                throw new Error("A kapcsolatfelvételi üzenet elküldése nem sikerült.");
            }

            alert("Üzenet sikeresen elküldve!");
            form.reset();
        } catch (error) {
            console.error(error);
            alert("Hiba történt az üzenet küldésekor. Kérlek, próbáld újra.");
        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.value = originalText;
            }
        }
    });
})();
