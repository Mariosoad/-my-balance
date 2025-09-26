import styles from "./page.module.css";
import ScaleAutoDetect from "./test";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <ScaleAutoDetect />
      </main>
    </div>
  );
}
