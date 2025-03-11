document.querySelector("form").addEventListener("submit", async function(event) {
    event.preventDefault(); // Megakadályozza az alapértelmezett beküldést
    let form = event.target;
    let formData = new FormData(form);

    let response = await fetch(form.action, {
        method: form.method,
        body: formData,
        headers: { "Accept": "application/json" }
    });

    if (response.ok) {
        alert("Üzenet sikeresen elküldve!");
        form.reset(); // Űrlap kiürítése
    } else {
        alert("Hiba történt az üzenet küldésekor.");
    }
});