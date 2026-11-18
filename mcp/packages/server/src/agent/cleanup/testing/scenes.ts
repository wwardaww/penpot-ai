import { FakePenpot, FakeShape } from "./FakePenpot";

/** Ids of the card list scene. */
export interface CardListScene {
    penpot: FakePenpot;
    screen: FakeShape;
    list: FakeShape;
    cards: FakeShape[];
    hidden: FakeShape;
    emptyGroup: FakeShape;
    zeroSize: FakeShape;
}

/**
 * A screen as a careless import leaves it: a group of three absolutely placed cards (background,
 * title, subtitle), a hidden layer, an empty group and a zero-size rectangle.
 */
export function cardListScene(): CardListScene {
    const penpot = new FakePenpot();
    const screen = new FakeShape("board", "Board 1", 0, 0, 400, 520);
    screen.fills = [{ fillColor: "#FFFFFF", fillOpacity: 1 }];
    penpot.page.root.add(screen);
    const titles = ["Buy milk", "Call Ana", "Book flights"];
    const cards = titles.map((title, i) => {
        const y = 100 + i * 120;
        const card = new FakeShape("group", `Group ${i + 1}`, 20, y, 360, 100);
        const bg = new FakeShape("rectangle", "Rectangle", 20, y, 360, 100);
        bg.fills = [{ fillColor: "#EEEEEE", fillOpacity: 1 }];
        const text = new FakeShape("text", "Title", 36, y + 16, 200, 20);
        text.characters = title;
        text.fills = [{ fillColor: "#111111", fillOpacity: 1 }];
        const sub = new FakeShape("text", "Subtitle", 36, y + 44, 200, 16);
        sub.characters = `Due ${i + 1} May`;
        sub.fills = [{ fillColor: "#666666", fillOpacity: 1 }];
        return card.add(bg, text, sub);
    });
    const list = new FakeShape("group", "Group 4", 20, 100, 360, 340).add(...cards);
    const hidden = new FakeShape("rectangle", "Old header", 0, 0, 400, 60);
    hidden.visible = false;
    hidden.fills = [{ fillColor: "#FF0000", fillOpacity: 1 }];
    const emptyGroup = new FakeShape("group", "Group 9", 10, 10, 1, 1);
    const zeroSize = new FakeShape("rectangle", "Rectangle 7", 50, 470, 0, 10);
    zeroSize.fills = [{ fillColor: "#000000", fillOpacity: 1 }];
    screen.add(hidden, list, emptyGroup, zeroSize);
    return { penpot, screen, list, cards, hidden, emptyGroup, zeroSize };
}
